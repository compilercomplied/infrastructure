import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createLetsEncryptIngress } from "./ingress";
import { createPVC } from "./k8s-pvc";
import { createBackupJob } from "../maintenance/backup";
import { AppHealthCheck, createHealthProbe } from "./health-probe";

export interface AppDatabase {
  type: "postgres" | "mariadb";
  host: pulumi.Input<string>;
  databaseName: string;
  username: string;
  passwordSecret: pulumi.Input<string>;
  enableBackup?: boolean; // Defaults to true
  clientImage?: string; 
}

export interface AppVolume {
  name: string;
  mountPath: string;
  size?: string; // defaults to "10Gi"
  storageClassName?: string;
  accessModes?: string[];
  pvcName?: string;
  external?: boolean;
  enableBackup?: boolean; // Defaults to true
  isEphemeral?: boolean; // Use emptyDir
  configMap?: k8s.types.input.core.v1.ConfigMapVolumeSource;
}

type IngressPeerSelector =
  | {
      podSelector: Record<string, string>;
      namespaceSelector?: Record<string, string>;
    }
  | {
      podSelector?: Record<string, string>;
      namespaceSelector: Record<string, string>;
    };

export type IngressRuleConfig = IngressPeerSelector & {
  name?: string;
  port?: number;
};

export interface AppEndpoint {
  name: string;
  containerPort: number;
  servicePort?: number;
  protocol?: "TCP" | "UDP" | "SCTP";
  ingress?: {
    name?: string;
    host: string;
    middlewares?: pulumi.Input<string>[];
    rateLimit?: false | { average?: number; burst?: number; period?: string };
  };
  allowIngressFrom?: IngressRuleConfig[];
}

export type ExposeConfig = {
  exposeType: "public";
  host: string;
};

type SelfhostedAppCommonArgs = {
  namespace: pulumi.Input<string>;
  image: string;
  databases?: AppDatabase[];
  volumes?: AppVolume[];
  env?: k8s.types.input.core.v1.EnvVar[];
  config?: Record<string, pulumi.Input<string>>;
  secrets?: Record<string, pulumi.Input<string>>;
  labels?: Record<string, string>;
  dependencies?: pulumi.Resource[];
  affinity?: k8s.types.input.core.v1.Affinity;
  command?: string[];
  args?: string[];
  strategy?: k8s.types.input.apps.v1.DeploymentStrategy;
  readinessProbe?: k8s.types.input.core.v1.Probe;
  livenessProbe?: k8s.types.input.core.v1.Probe;
  ipFamilyPolicy?: string;
  ipFamilies?: string[];
  serviceAccountName?: pulumi.Input<string>;
  automountServiceAccountToken?: boolean;
  runtimeClassName?: pulumi.Input<string>;
  resources?: k8s.types.input.core.v1.ResourceRequirements;
  initContainers?: k8s.types.input.core.v1.Container[];
  additionalContainers?: k8s.types.input.core.v1.Container[];
  additionalVolumes?: k8s.types.input.core.v1.Volume[];
  additionalVolumeMounts?: k8s.types.input.core.v1.VolumeMount[];
  childAliases?: pulumi.Alias[];
};

type LegacyEndpointConfig = {
  endpoints?: never;
  containerPort: number;
  allowIngressFrom?: IngressRuleConfig[];
  middlewares?: pulumi.Input<string>[];
  rateLimit?: false | { average?: number; burst?: number; period?: string };
  healthCheck?: AppHealthCheck;
} & (ExposeConfig | { exposeType: "private"; host?: never });

type MultiEndpointConfig = {
  endpoints: AppEndpoint[];
  containerPort?: never;
  exposeType?: never;
  host?: never;
  allowIngressFrom?: never;
  middlewares?: never;
  rateLimit?: never;
  healthCheck?: never;
};

export type SelfhostedAppArgs = SelfhostedAppCommonArgs & (LegacyEndpointConfig | MultiEndpointConfig);

function hasMultipleEndpoints(args: SelfhostedAppArgs): args is SelfhostedAppCommonArgs & MultiEndpointConfig {
  return args.endpoints !== undefined;
}

function getEndpoints(args: SelfhostedAppArgs): AppEndpoint[] {
  if (hasMultipleEndpoints(args)) {
    if (args.endpoints.length === 0) {
      throw new Error("SelfhostedApp requires at least one endpoint.");
    }
    return args.endpoints;
  }

  return [{
    name: "http",
    containerPort: args.containerPort,
    servicePort: 80,
    ingress: args.exposeType === "public" ? {
      name: undefined,
      host: args.host,
      middlewares: args.middlewares,
      rateLimit: args.rateLimit,
    } : undefined,
    allowIngressFrom: args.allowIngressFrom,
  }];
}

interface VolumeConfigResult {
  pvcs: k8s.core.v1.PersistentVolumeClaim[];
  k8sVolumes: k8s.types.input.core.v1.Volume[];
  k8sVolumeMounts: k8s.types.input.core.v1.VolumeMount[];
  backupPVCs: { pvcName: string; mountPath: string }[];
}

export class SelfhostedApp extends pulumi.ComponentResource {
  public readonly deployment: k8s.apps.v1.Deployment;
  public readonly service: k8s.core.v1.Service;
  public readonly configMap?: k8s.core.v1.ConfigMap;
  public readonly secret?: k8s.core.v1.Secret;
  public readonly pvcs: k8s.core.v1.PersistentVolumeClaim[];
  public readonly ingress?: k8s.networking.v1.Ingress;
  public readonly ingresses: k8s.networking.v1.Ingress[];
  public readonly traefikPolicy?: k8s.networking.v1.NetworkPolicy;
  public readonly traefikPolicies: k8s.networking.v1.NetworkPolicy[];
  public readonly internalPolicies: k8s.networking.v1.NetworkPolicy[];
  public readonly backupJobs: k8s.batch.v1.CronJob[];
  public readonly healthProbe?: k8s.apiextensions.CustomResource;

  constructor(name: string, args: SelfhostedAppArgs, opts?: pulumi.ComponentResourceOptions) {
    super("custom:selfhosted:App", name, {}, opts);

    const componentAlias = { parent: pulumi.rootStackResource };
    const childAliases = [componentAlias, ...(args.childAliases || [])];
    const childOpts = { parent: this, aliases: childAliases };
    const dependencies = args.dependencies || [];
    const endpoints = getEndpoints(args);

    const { configMap, secret, envFrom } = this.configureEnvironment(name, args.namespace, args.config, args.secrets, dependencies, childOpts);
    this.configMap = configMap;
    this.secret = secret;

    const volConfig = this.configureVolumes(name, args.namespace, args.volumes, dependencies, childOpts, childAliases);
    this.pvcs = volConfig.pvcs;

    const deploymentDeps = [...dependencies, ...this.pvcs];
    if (this.configMap) {
      deploymentDeps.push(this.configMap);
    }
    if (this.secret) {
      deploymentDeps.push(this.secret);
    }
    
    this.deployment = this.configureDeployment(name, args, endpoints, envFrom, volConfig.k8sVolumes, volConfig.k8sVolumeMounts, deploymentDeps, childOpts);

    this.service = this.configureService(name, args, endpoints, childOpts);

    const exposures = this.configureIngresses(name, args, endpoints, this.service, childAliases);
    this.ingresses = exposures.map(exposure => exposure.ingress);
    this.traefikPolicies = exposures.flatMap(exposure => exposure.policy ? [exposure.policy] : []);
    this.ingress = this.ingresses[0];
    this.traefikPolicy = this.traefikPolicies[0];

    this.internalPolicies = this.configureInternalPolicies(name, args, endpoints, childOpts);

    this.backupJobs = this.configureBackups(name, args, volConfig.backupPVCs, dependencies, childAliases);

    if (args.healthCheck) {
      this.healthProbe = createHealthProbe({
        name,
        namespace: args.namespace,
        service: this.service,
        healthCheck: args.healthCheck,
        parent: this,
        aliases: childAliases,
      });
    }

    this.registerOutputs({});
  }

  private configureEnvironment(
    name: string,
    namespace: pulumi.Input<string>,
    config: Record<string, pulumi.Input<string>> | undefined,
    secrets: Record<string, pulumi.Input<string>> | undefined,
    dependencies: pulumi.Resource[],
    childOpts: pulumi.CustomResourceOptions
  ): {
    configMap?: k8s.core.v1.ConfigMap;
    secret?: k8s.core.v1.Secret;
    envFrom: k8s.types.input.core.v1.EnvFromSource[];
  } {
    const envFrom: k8s.types.input.core.v1.EnvFromSource[] = [];
    let configMap: k8s.core.v1.ConfigMap | undefined;
    let secret: k8s.core.v1.Secret | undefined;

    if (config && Object.keys(config).length > 0) {
      configMap = new k8s.core.v1.ConfigMap(`${name}-config`, {
        metadata: {
          name: `${name}-config`,
          namespace,
        },
        data: config,
      }, { dependsOn: dependencies, ...childOpts });

      envFrom.push({ configMapRef: { name: configMap.metadata.name } });
    }

    if (secrets && Object.keys(secrets).length > 0) {
      secret = new k8s.core.v1.Secret(`${name}-secrets`, {
        metadata: {
          name: `${name}-secrets`,
          namespace,
        },
        stringData: secrets,
      }, { dependsOn: dependencies, ...childOpts });

      envFrom.push({ secretRef: { name: secret.metadata.name } });
    }

    return { configMap, secret, envFrom };
  }

  private configureVolumes(
    name: string,
    namespace: pulumi.Input<string>,
    volumes: AppVolume[] | undefined,
    dependencies: pulumi.Resource[],
    childOpts: pulumi.CustomResourceOptions,
    childAliases: pulumi.Alias[]
  ): VolumeConfigResult {
    const pvcs: k8s.core.v1.PersistentVolumeClaim[] = [];
    const k8sVolumes: k8s.types.input.core.v1.Volume[] = [];
    const k8sVolumeMounts: k8s.types.input.core.v1.VolumeMount[] = [];
    const backupPVCs: { pvcName: string; mountPath: string }[] = [];

    if (!volumes) {
      return { pvcs, k8sVolumes, k8sVolumeMounts, backupPVCs };
    }

    for (const vol of volumes) {
      if (vol.configMap) {
        k8sVolumes.push({ name: vol.name, configMap: vol.configMap });
      } else if (vol.isEphemeral) {
        k8sVolumes.push({ name: vol.name, emptyDir: {} });
      } else {
        const pvcName = vol.pvcName || `${name}-${vol.name}-pvc`;
        
        if (!vol.external) {
          const pvc = createPVC({
            name: pvcName,
            namespace,
            size: vol.size || "10Gi",
            storageClassName: vol.storageClassName,
            accessModes: vol.accessModes,
            dependencies,
            parent: this,
            aliases: childAliases,
          });
          pvcs.push(pvc);
        }

        k8sVolumes.push({
          name: vol.name,
          persistentVolumeClaim: { claimName: pvcName },
        });

        if (vol.enableBackup !== false) {
          backupPVCs.push({ pvcName, mountPath: vol.mountPath });
        }
      }

      k8sVolumeMounts.push({
        name: vol.name,
        mountPath: vol.mountPath,
      });
    }

    return { pvcs, k8sVolumes, k8sVolumeMounts, backupPVCs };
  }

  private configureDeployment(
    name: string,
    args: SelfhostedAppArgs,
    endpoints: AppEndpoint[],
    envFrom: k8s.types.input.core.v1.EnvFromSource[],
    k8sVolumes: k8s.types.input.core.v1.Volume[],
    k8sVolumeMounts: k8s.types.input.core.v1.VolumeMount[],
    deploymentDeps: pulumi.Resource[],
    childOpts: pulumi.CustomResourceOptions
  ): k8s.apps.v1.Deployment {
    return new k8s.apps.v1.Deployment(name, {
      metadata: { name, namespace: args.namespace },
      spec: {
        replicas: 1,
        strategy: args.strategy,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name, ...(args.labels || {}) } },
          spec: {
            serviceAccountName: args.serviceAccountName,
            automountServiceAccountToken: args.automountServiceAccountToken,
            runtimeClassName: args.runtimeClassName,
            containers: [{
              name,
              image: args.image,
              ports: endpoints.map(endpoint => ({
                containerPort: endpoint.containerPort,
                name: endpoint.name,
                protocol: endpoint.protocol,
              })),
              envFrom,
              env: args.env || [],
              volumeMounts: [...k8sVolumeMounts, ...(args.additionalVolumeMounts || [])],
              command: args.command,
              args: args.args,
              readinessProbe: args.readinessProbe,
              livenessProbe: args.livenessProbe,
              resources: args.resources,
            }, ...(args.additionalContainers || [])],
            initContainers: args.initContainers,
            volumes: [...k8sVolumes, ...(args.additionalVolumes || [])],
            affinity: args.affinity,
          },
        },
      },
    }, { dependsOn: deploymentDeps, ...childOpts });
  }

  private configureService(
    name: string,
    args: SelfhostedAppArgs,
    endpoints: AppEndpoint[],
    childOpts: pulumi.CustomResourceOptions
  ): k8s.core.v1.Service {
    return new k8s.core.v1.Service(name, {
      metadata: {
        name,
        namespace: args.namespace,
        labels: { app: name },
      },
      spec: {
        ipFamilyPolicy: args.ipFamilyPolicy || "PreferDualStack",
        ipFamilies: args.ipFamilies || ["IPv4", "IPv6"],
        ports: endpoints.map(endpoint => ({
          port: endpoint.servicePort ?? endpoint.containerPort,
          targetPort: endpoint.containerPort,
          protocol: endpoint.protocol || "TCP",
          name: endpoint.name,
        })),
        selector: { app: name },
      },
    }, { dependsOn: this.deployment, ...childOpts });
  }

  private configureIngresses(
    name: string,
    args: SelfhostedAppArgs,
    endpoints: AppEndpoint[],
    service: k8s.core.v1.Service,
    childAliases: pulumi.Alias[]
  ): { ingress: k8s.networking.v1.Ingress; policy?: k8s.networking.v1.NetworkPolicy }[] {
    return endpoints.flatMap(endpoint => {
      if (!endpoint.ingress) {
        return [];
      }

      return [createLetsEncryptIngress({
        name: endpoint.ingress.name || (hasMultipleEndpoints(args) ? `${name}-${endpoint.name}` : name),
        namespace: args.namespace,
        host: endpoint.ingress.host,
        serviceName: service.metadata.name,
        servicePort: endpoint.servicePort ?? endpoint.containerPort,
        targetPort: endpoint.containerPort,
        podSelector: { app: name },
        rateLimit: endpoint.ingress.rateLimit,
        middlewares: endpoint.ingress.middlewares,
        dependencies: [service],
        parent: this,
        aliases: childAliases,
      })];
    });
  }

  private configureInternalPolicies(
    name: string,
    args: SelfhostedAppArgs,
    endpoints: AppEndpoint[],
    childOpts: pulumi.CustomResourceOptions
  ): k8s.networking.v1.NetworkPolicy[] {
    const policies: k8s.networking.v1.NetworkPolicy[] = [];

    for (const endpoint of endpoints) {
      for (const rule of endpoint.allowIngressFrom || []) {
        const clientName = rule.name || Object.values(rule.podSelector || {})[0];
        if (!clientName) {
          throw new Error(`Ingress rule for ${name}/${endpoint.name} requires a name or a non-empty pod selector.`);
        }
        const policyName = `${name}-allow-${clientName}`;

        const policy = new k8s.networking.v1.NetworkPolicy(policyName, {
          metadata: { name: policyName, namespace: args.namespace },
          spec: {
            podSelector: { matchLabels: { app: name } },
            ingress: [{
              from: [{
                ...(rule.podSelector ? { podSelector: { matchLabels: rule.podSelector } } : {}),
                ...(rule.namespaceSelector ? { namespaceSelector: { matchLabels: rule.namespaceSelector } } : {}),
              }],
              ports: [{
                port: rule.port || endpoint.containerPort,
                protocol: hasMultipleEndpoints(args) ? endpoint.protocol || "TCP" : undefined,
              }],
            }],
            policyTypes: ["Ingress"],
          },
        }, { dependsOn: this.deployment, ...childOpts });
        policies.push(policy);
      }
    }
    return policies;
  }

  private configureBackups(
    name: string,
    args: SelfhostedAppArgs,
    backupPVCs: { pvcName: string; mountPath: string }[],
    dependencies: pulumi.Resource[],
    childAliases: pulumi.Alias[]
  ): k8s.batch.v1.CronJob[] {
    const jobs: k8s.batch.v1.CronJob[] = [];

    // PVC Backups
    for (const backup of backupPVCs) {
      const job = createBackupJob({
        appName: name,
        namespace: args.namespace,
        source: {
          type: "pvc",
          pvcName: backup.pvcName,
          mountPath: backup.mountPath,
        },
        dependencies: [...dependencies, this.deployment],
        parent: this,
        aliases: childAliases,
      });
      jobs.push(job);
    }

    // Database Backups
    if (args.databases) {
      for (const db of args.databases) {
        if (db.enableBackup !== false) {
          const source: any = {
            type: db.type,
            databaseName: db.databaseName,
            dbHost: db.host,
            dbUser: db.username,
            dbPasswordSecret: db.passwordSecret,
          };
          if (db.type === "mariadb" && db.clientImage) {
            source.clientImage = db.clientImage;
          }
          
          const job = createBackupJob({
            appName: name,
            namespace: args.namespace,
            source,
            dependencies: [...dependencies, this.deployment],
            parent: this,
            aliases: childAliases,
          });
          jobs.push(job);
        }
      }
    }

    return jobs;
  }
}
