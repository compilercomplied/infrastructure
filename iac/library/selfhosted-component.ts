import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createLetsEncryptIngress } from "./ingress";
import { createPVC } from "./k8s-pvc";
import { createBackupJob } from "../maintenance/backup";

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

export interface IngressRuleConfig {
  podSelector: Record<string, string>;
  namespaceSelector?: Record<string, string>;
  port?: number;
}

export type ExposeConfig = {
  exposeType: "public";
  host: string;
};

export type SelfhostedAppArgs = {
  namespace: pulumi.Input<string>;
  image: string;
  containerPort: number;
  databases?: AppDatabase[];
  volumes?: AppVolume[];
  env?: k8s.types.input.core.v1.EnvVar[];
  secrets?: Record<string, pulumi.Input<string>>;
  labels?: Record<string, string>;
  allowIngressFrom?: IngressRuleConfig[];
  dependencies?: pulumi.Resource[];
  middlewares?: pulumi.Input<string>[];
  affinity?: k8s.types.input.core.v1.Affinity;
  command?: string[];
  args?: string[];
  strategy?: k8s.types.input.apps.v1.DeploymentStrategy;
  readinessProbe?: k8s.types.input.core.v1.Probe;
  livenessProbe?: k8s.types.input.core.v1.Probe;
  rateLimit?: false | { average?: number; burst?: number; period?: string };
  ipFamilyPolicy?: string;
  ipFamilies?: string[];
} & (ExposeConfig | { exposeType: "private"; host?: never });

interface VolumeConfigResult {
  pvcs: k8s.core.v1.PersistentVolumeClaim[];
  k8sVolumes: k8s.types.input.core.v1.Volume[];
  k8sVolumeMounts: k8s.types.input.core.v1.VolumeMount[];
  backupPVCs: { pvcName: string; mountPath: string }[];
}

export class SelfhostedApp extends pulumi.ComponentResource {
  public readonly deployment: k8s.apps.v1.Deployment;
  public readonly service: k8s.core.v1.Service;
  public readonly secret?: k8s.core.v1.Secret;
  public readonly pvcs: k8s.core.v1.PersistentVolumeClaim[];
  public readonly ingress?: k8s.networking.v1.Ingress;
  public readonly traefikPolicy?: k8s.networking.v1.NetworkPolicy;
  public readonly internalPolicies: k8s.networking.v1.NetworkPolicy[];
  public readonly backupJobs: k8s.batch.v1.CronJob[];

  constructor(name: string, args: SelfhostedAppArgs, opts?: pulumi.ComponentResourceOptions) {
    super("custom:selfhosted:App", name, {}, opts);

    const componentAlias = { parent: pulumi.rootStackResource };
    const childOpts = { parent: this, aliases: [componentAlias] };
    const dependencies = args.dependencies || [];

    const { secret, envFrom } = this.configureSecrets(name, args.namespace, args.secrets, dependencies, childOpts);
    this.secret = secret;

    const volConfig = this.configureVolumes(name, args.namespace, args.volumes, dependencies, childOpts, componentAlias);
    this.pvcs = volConfig.pvcs;

    const deploymentDeps = [...dependencies, ...this.pvcs];
    if (this.secret) {
      deploymentDeps.push(this.secret);
    }
    
    this.deployment = this.configureDeployment(name, args, envFrom, volConfig.k8sVolumes, volConfig.k8sVolumeMounts, deploymentDeps, childOpts);

    this.service = this.configureService(name, args, childOpts);

    const exposure = this.configureIngress(name, args, this.service, componentAlias);
    this.ingress = exposure?.ingress;
    this.traefikPolicy = exposure?.policy;

    this.internalPolicies = this.configureInternalPolicies(name, args, childOpts);

    this.backupJobs = this.configureBackups(name, args, volConfig.backupPVCs, dependencies, componentAlias);

    this.registerOutputs({});
  }

  private configureSecrets(
    name: string,
    namespace: pulumi.Input<string>,
    secrets: Record<string, pulumi.Input<string>> | undefined,
    dependencies: pulumi.Resource[],
    childOpts: pulumi.CustomResourceOptions
  ): { secret?: k8s.core.v1.Secret; envFrom: k8s.types.input.core.v1.EnvFromSource[] } {
    const envFrom: k8s.types.input.core.v1.EnvFromSource[] = [];
    if (!secrets || Object.keys(secrets).length === 0) {
      return { envFrom };
    }

    const secret = new k8s.core.v1.Secret(`${name}-secrets`, {
      metadata: {
        name: `${name}-secrets`,
        namespace,
      },
      stringData: secrets,
    }, { dependsOn: dependencies, ...childOpts });

    envFrom.push({
      secretRef: {
        name: secret.metadata.name,
      },
    });

    return { secret, envFrom };
  }

  private configureVolumes(
    name: string,
    namespace: pulumi.Input<string>,
    volumes: AppVolume[] | undefined,
    dependencies: pulumi.Resource[],
    childOpts: pulumi.CustomResourceOptions,
    componentAlias: pulumi.Alias
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
            aliases: [componentAlias],
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
            containers: [{
              name,
              image: args.image,
              ports: [{ containerPort: args.containerPort, name: "http" }],
              envFrom,
              env: args.env || [],
              volumeMounts: k8sVolumeMounts,
              command: args.command,
              args: args.args,
              readinessProbe: args.readinessProbe,
              livenessProbe: args.livenessProbe,
            }],
            volumes: k8sVolumes,
            affinity: args.affinity,
          },
        },
      },
    }, { dependsOn: deploymentDeps, ...childOpts });
  }

  private configureService(
    name: string,
    args: SelfhostedAppArgs,
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
        ports: [{ port: 80, targetPort: args.containerPort, protocol: "TCP", name: "http" }],
        selector: { app: name },
      },
    }, { dependsOn: this.deployment, ...childOpts });
  }

  private configureIngress(
    name: string,
    args: SelfhostedAppArgs,
    service: k8s.core.v1.Service,
    componentAlias: pulumi.Alias
  ): { ingress: k8s.networking.v1.Ingress; policy?: k8s.networking.v1.NetworkPolicy } | undefined {
    if (args.exposeType !== "public") {
      return undefined;
    }

    return createLetsEncryptIngress({
      name,
      namespace: args.namespace,
      host: args.host!,
      serviceName: service.metadata.name,
      servicePort: 80,
      targetPort: args.containerPort,
      podSelector: { app: name },
      rateLimit: args.rateLimit,
      middlewares: args.middlewares,
      dependencies: [service],
      parent: this,
      aliases: [componentAlias],
    });
  }

  private configureInternalPolicies(
    name: string,
    args: SelfhostedAppArgs,
    childOpts: pulumi.CustomResourceOptions
  ): k8s.networking.v1.NetworkPolicy[] {
    const policies: k8s.networking.v1.NetworkPolicy[] = [];
    if (!args.allowIngressFrom) {
      return policies;
    }

    for (const rule of args.allowIngressFrom) {
      const clientName = Object.values(rule.podSelector)[0];
      const policyName = `${name}-allow-${clientName}`;

      const policy = new k8s.networking.v1.NetworkPolicy(policyName, {
        metadata: { name: policyName, namespace: args.namespace },
        spec: {
          podSelector: { matchLabels: { app: name } },
          ingress: [
            {
              from: [
                {
                  podSelector: { matchLabels: rule.podSelector },
                  ...(rule.namespaceSelector ? { namespaceSelector: { matchLabels: rule.namespaceSelector } } : {})
                },
              ],
              ports: [{ port: rule.port || args.containerPort }],
            },
          ],
          policyTypes: ["Ingress"],
        },
      }, { dependsOn: this.deployment, ...childOpts });
      policies.push(policy);
    }
    return policies;
  }

  private configureBackups(
    name: string,
    args: SelfhostedAppArgs,
    backupPVCs: { pvcName: string; mountPath: string }[],
    dependencies: pulumi.Resource[],
    componentAlias: pulumi.Alias
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
        aliases: [componentAlias],
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
            aliases: [componentAlias],
          });
          jobs.push(job);
        }
      }
    }

    return jobs;
  }
}
