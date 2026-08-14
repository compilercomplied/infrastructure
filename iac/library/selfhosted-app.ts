import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createLetsEncryptIngress } from "./ingress";
import { createPVC } from "./k8s-pvc";

export interface VolumeConfig {
  name: string;
  mountPath: string;
  size?: string; // defaults to "10Gi"
  storageClassName?: string; // defaults to "local-path"
  accessModes?: string[]; // defaults to ["ReadWriteOnce"]
  pvcName?: string; // custom name to map to existing persistent volume claims
  external?: boolean; // if true, does not create the PVC resource, assuming it is declared elsewhere
  configMap?: k8s.types.input.core.v1.ConfigMapVolumeSource;
  // emptyDir is ephemeral and reset on every pod restart — suitable for
  // in-process scratch dirs (e.g. PROMETHEUS_MULTIPROC_DIR) that must never persist.
  emptyDir?: k8s.types.input.core.v1.EmptyDirVolumeSource;
}

export interface IngressRuleConfig {
  podSelector: Record<string, string>;
  port?: number;
}

export type ExposeConfig = {
  exposeType: "public";
  host: string;
};

export type SelfhostedAppArgs = {
  name: string;
  namespace: pulumi.Input<string>;
  image: string;
  containerPort: number;
  env?: k8s.types.input.core.v1.EnvVar[];
  secrets?: Record<string, pulumi.Input<string>>;
  volumes?: VolumeConfig[];
  dependencies?: pulumi.Resource[];
  middlewares?: pulumi.Input<string>[];
  affinity?: k8s.types.input.core.v1.Affinity;
  labels?: Record<string, string>;
  allowIngressFrom?: IngressRuleConfig[];
  command?: string[];
  args?: string[];
  strategy?: k8s.types.input.apps.v1.DeploymentStrategy;
  readinessProbe?: k8s.types.input.core.v1.Probe;
  livenessProbe?: k8s.types.input.core.v1.Probe;
  rateLimit?: false | { average?: number; burst?: number; period?: string };
  ipFamilyPolicy?: string;
  ipFamilies?: string[];
} & (ExposeConfig | { exposeType: "private"; host?: never });

// Configures standard Kubernetes resources for self-hosted apps to eliminate boilerplate.
// Establishes consistent naming, label selectors, and TLS ingress.
export function createSelfhostedApp(args: SelfhostedAppArgs) {
  const {
    name,
    namespace,
    image,
    containerPort,
    exposeType,
    env = [],
    secrets,
    volumes,
    dependencies = [],
    labels = {},
    command,
    args: containerArgs,
  } = args;

  let secretResource: k8s.core.v1.Secret | undefined;
  const envFrom: k8s.types.input.core.v1.EnvFromSource[] = [];

  // Exposing secrets directly as environment variables via envFrom simplifies configuration,
  // making all keys in the secret available in the container environment.
  if (secrets && Object.keys(secrets).length > 0) {
    secretResource = new k8s.core.v1.Secret(`${name}-secrets`, {
      metadata: {
        name: `${name}-secrets`,
        namespace,
      },
      stringData: secrets,
    }, { dependsOn: dependencies });

    envFrom.push({
      secretRef: {
        name: secretResource.metadata.name,
      },
    });
  }

  const pvcs: k8s.core.v1.PersistentVolumeClaim[] = [];
  const k8sVolumes: k8s.types.input.core.v1.Volume[] = [];
  const k8sVolumeMounts: k8s.types.input.core.v1.VolumeMount[] = [];

  // Automates volume provision and mounting parameters. Each volume gets a unique PVC.
  if (volumes) {
    for (const vol of volumes) {
      if (vol.configMap) {
        k8sVolumes.push({
          name: vol.name,
          configMap: vol.configMap,
        });
      } else if (vol.emptyDir !== undefined) {
        k8sVolumes.push({
          name: vol.name,
          emptyDir: vol.emptyDir,
        });
      } else {
        const pvcName = vol.pvcName || `${name}-${vol.name}-pvc`;
        
        if (!vol.external) {
          const pvc = createPVC({
            name: pvcName,
            namespace,
            size: vol.size,
            storageClassName: vol.storageClassName,
            accessModes: vol.accessModes,
            dependencies,
          });
          pvcs.push(pvc);
        }

        k8sVolumes.push({
          name: vol.name,
          persistentVolumeClaim: {
            claimName: pvcName,
          },
        });
      }

      k8sVolumeMounts.push({
        name: vol.name,
        mountPath: vol.mountPath,
      });
    }
  }

  const deploymentDeps = [...dependencies, ...pvcs];
  if (secretResource) {
    deploymentDeps.push(secretResource);
  }

  const deployment = new k8s.apps.v1.Deployment(name, {
    metadata: {
      name,
      namespace,
    },
    spec: {
      replicas: 1,
      strategy: args.strategy,
      selector: {
        matchLabels: { app: name },
      },
      template: {
        metadata: {
          labels: { app: name, ...labels },
        },
        spec: {
          containers: [{
            name,
            image,
            ports: [{ containerPort, name: "http" }],
            envFrom,
            env,
            volumeMounts: k8sVolumeMounts,
            command,
            args: containerArgs,
            readinessProbe: args.readinessProbe,
            livenessProbe: args.livenessProbe,
          }],
          volumes: k8sVolumes,
          affinity: args.affinity,
        },
      },
    },
  }, { dependsOn: deploymentDeps });

  const serviceAnnotations: Record<string, string> = {};

  const service = new k8s.core.v1.Service(name, {
    metadata: {
      name,
      namespace,
      annotations: serviceAnnotations,
      // Prometheus Operator generates a relabelling `keep` rule that matches on
      // __meta_kubernetes_service_label_<key> — the Service must carry the same
      // selector label for any ServiceMonitor targeting it to pass through.
      labels: { app: name },
    },
    spec: {
      ipFamilyPolicy: args.ipFamilyPolicy || "PreferDualStack",
      ipFamilies: args.ipFamilies || ["IPv4", "IPv6"],
      ports: [{ port: 80, targetPort: containerPort, protocol: "TCP", name: "http" }],
      selector: { app: name },
    },
  }, { dependsOn: deployment });

  let ingress: k8s.networking.v1.Ingress | undefined;
  let traefikPolicy: k8s.networking.v1.NetworkPolicy | undefined;

  if (args.exposeType === "public") {
    const exposure = createLetsEncryptIngress({
      name,
      namespace,
      host: args.host,
      serviceName: service.metadata.name,
      servicePort: 80,
      targetPort: containerPort,
      podSelector: { app: name },
      rateLimit: args.rateLimit,
      middlewares: args.middlewares,
      dependencies: [service],
    });
    ingress = exposure.ingress;
    traefikPolicy = exposure.policy;
  }

  const internalPolicies: k8s.networking.v1.NetworkPolicy[] = [];

  if (args.allowIngressFrom && args.allowIngressFrom.length > 0) {
    for (const rule of args.allowIngressFrom) {
      const clientName = Object.values(rule.podSelector)[0];
      const policyName = `${name}-allow-${clientName}`;

      // Configures internal, pod-to-pod network rules. Restricting ingress on a per-app basis
      // is key to enforcing our zero-trust lateral isolation boundaries.
      const policy = new k8s.networking.v1.NetworkPolicy(policyName, {
        metadata: {
          name: policyName,
          namespace,
        },
        spec: {
          podSelector: {
            matchLabels: { app: name },
          },
          ingress: [
            {
              from: [
                {
                  podSelector: {
                    matchLabels: rule.podSelector,
                  },
                },
              ],
              ports: [{ port: rule.port || containerPort }],
            },
          ],
          policyTypes: ["Ingress"],
        },
      }, { dependsOn: deployment });
      internalPolicies.push(policy);
    }
  }

  return {
    secret: secretResource,
    pvcs,
    deployment,
    service,
    ingress,
    traefikPolicy,
    internalPolicies,
  };
}
