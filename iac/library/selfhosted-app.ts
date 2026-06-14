import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createLetsEncryptIngress } from "./ingress";

export interface VolumeConfig {
  name: string;
  mountPath: string;
  size?: string; // defaults to "10Gi"
  storageClassName?: string; // defaults to "local-path"
  accessModes?: string[]; // defaults to ["ReadWriteOnce"]
  pvcName?: string; // custom name to map to existing persistent volume claims
}

export type ExposeConfig =
  | {
      exposeType: "tailscale";
      tailscale?: {
        hostname?: string; // defaults to name
        tags?: string[]; // defaults to ["tag:kubernetes"]
      };
    }
  | {
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
} & ExposeConfig;

// Configures standard Kubernetes resources for self-hosted apps to eliminate boilerplate.
// Establishes consistent naming, label selectors, Tailscale integration, and TLS ingress.
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
      const pvcName = vol.pvcName || `${name}-${vol.name}-pvc`;
      const pvc = new k8s.core.v1.PersistentVolumeClaim(pvcName, {
        metadata: {
          name: pvcName,
          namespace,
        },
        spec: {
          accessModes: vol.accessModes || ["ReadWriteOnce"],
          storageClassName: vol.storageClassName || "local-path",
          resources: {
            requests: {
              storage: vol.size || "10Gi",
            },
          },
        },
      }, { dependsOn: dependencies });

      pvcs.push(pvc);

      k8sVolumes.push({
        name: vol.name,
        persistentVolumeClaim: {
          claimName: pvc.metadata.name,
        },
      });

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
      selector: {
        matchLabels: { app: name },
      },
      template: {
        metadata: {
          labels: { app: name },
        },
        spec: {
          containers: [{
            name,
            image,
            ports: [{ containerPort, name: "http" }],
            envFrom,
            env,
            volumeMounts: k8sVolumeMounts,
          }],
          volumes: k8sVolumes,
        },
      },
    },
  }, { dependsOn: deploymentDeps });

  const serviceAnnotations: Record<string, string> = {};
  // Exposes the service securely over Tailscale using the cluster's Tailscale operator.
  if (args.exposeType === "tailscale") {
    const tsConfig = args.tailscale || {};
    const tsHostname = tsConfig.hostname || name;
    const tsTags = tsConfig.tags || ["tag:kubernetes"];
    serviceAnnotations["tailscale.com/expose"] = "true";
    serviceAnnotations["tailscale.com/hostname"] = tsHostname;
    serviceAnnotations["tailscale.com/tags"] = tsTags.join(",");
  }

  const service = new k8s.core.v1.Service(name, {
    metadata: {
      name,
      namespace,
      annotations: serviceAnnotations,
    },
    spec: {
      ports: [{ port: 80, targetPort: containerPort, protocol: "TCP", name: "http" }],
      selector: { app: name },
    },
  }, { dependsOn: deployment });

  let ingress: k8s.networking.v1.Ingress | undefined;
  if (args.exposeType === "public") {
    ingress = createLetsEncryptIngress({
      name,
      namespace,
      host: args.host,
      serviceName: service.metadata.name,
      middlewares: args.middlewares,
      dependencies: [service],
    });
  }

  return {
    secret: secretResource,
    pvcs,
    deployment,
    service,
    ingress,
  };
}
