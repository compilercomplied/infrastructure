import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as crypto from "crypto";
import { createLetsEncryptIngress } from "./ingress";
import { createBackupJob } from "../operations/maintenance/backup";
import { AppHealthCheck, createWorkloadHealthProbe } from "./workload-health-probe";
import { IngressPeerSelector, PeerIngressRule, createPeerIngressPolicies } from "./workload-network-policy";
import { createPrivateService } from "./workload-service";
import { ManagedVolume, createManagedVolumeBackups, planManagedVolumes } from "./workload-volumes";
import { createManagedEnvironment } from "./workload-environment";
import { AppSettings } from "./app-settings";

function environmentChecksum(values?: Record<string, pulumi.Input<string>>): pulumi.Output<string> | undefined {
  if (!values || Object.keys(values).length === 0) {
    return undefined;
  }

  return pulumi.output(values).apply(resolved => crypto
    .createHash("sha256")
    .update(JSON.stringify(Object.entries(resolved).sort(([left], [right]) => left.localeCompare(right))))
    .digest("hex"));
}

export interface AppDatabase {
  type: "postgres" | "mariadb";
  host: pulumi.Input<string>;
  databaseName: string;
  username: string;
  passwordSecret: pulumi.Input<string>;
  enableBackup?: boolean; // Defaults to true
  clientImage?: string; 
}

export interface AppVolume extends ManagedVolume {}

export type { IngressPeerSelector };
export type IngressRuleConfig = PeerIngressRule;

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
  healthCheck?: AppHealthCheck;
}

export type AppDeploymentStrategy = Omit<k8s.types.input.apps.v1.DeploymentStrategy, "rollingUpdate"> & {
  rollingUpdate?: k8s.types.input.apps.v1.RollingUpdateDeployment | null;
};

type SelfhostedAppCommonArgs = {
  namespace: pulumi.Input<string>;
  image: string;
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  endpoints: [AppEndpoint, ...AppEndpoint[]];
  databases?: AppDatabase[];
  settings?: AppSettings;
  volumes?: AppVolume[];
  env?: k8s.types.input.core.v1.EnvVar[];
  config?: Record<string, pulumi.Input<string>>;
  secrets?: Record<string, pulumi.Input<string>>;
  labels?: Record<string, string>;
  dependencies?: pulumi.Resource[];
  affinity?: k8s.types.input.core.v1.Affinity;
  nodeSelector?: Record<string, pulumi.Input<string>>;
  podSecurityContext?: k8s.types.input.core.v1.PodSecurityContext;
  containerSecurityContext?: k8s.types.input.core.v1.SecurityContext;
  command?: string[];
  args?: string[];
  strategy?: AppDeploymentStrategy;
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

export type SelfhostedAppArgs = SelfhostedAppCommonArgs;

export class SelfhostedApp extends pulumi.ComponentResource {
  public readonly deployment: k8s.apps.v1.Deployment;
  public readonly service: k8s.core.v1.Service;
  public readonly configMap?: k8s.core.v1.ConfigMap;
  public readonly secret?: k8s.core.v1.Secret;
  public readonly pvcs: k8s.core.v1.PersistentVolumeClaim[];
  public readonly ingresses: k8s.networking.v1.Ingress[];
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
    const endpoints = args.endpoints;

    const config = args.settings?.config ?? args.config;
    const secrets = args.settings?.secrets ?? args.secrets;
    const { configMap, secret, envFrom } = createManagedEnvironment({
      name,
      namespace: args.namespace,
      config,
      secrets,
      dependencies,
      parent: this,
      aliases: childAliases,
    });
    this.configMap = configMap;
    this.secret = secret;
    const configChecksum = args.settings ? environmentChecksum(config) : undefined;
    const secretChecksum = args.settings ? environmentChecksum(secrets) : undefined;

    const volConfig = planManagedVolumes({
      appName: name,
      namespace: args.namespace,
      volumes: args.volumes,
      dependencies,
      parent: this,
      aliases: childAliases,
    });
    this.pvcs = volConfig.pvcs;

    const deploymentDeps = [...dependencies, ...this.pvcs];
    if (this.configMap) {
      deploymentDeps.push(this.configMap);
    }
    if (this.secret) {
      deploymentDeps.push(this.secret);
    }
    
    this.deployment = this.configureDeployment(
      name,
      args,
      endpoints,
      envFrom,
      volConfig.volumes,
      volConfig.volumeMounts,
      deploymentDeps,
      childOpts,
      configChecksum,
      secretChecksum,
    );

    this.service = createPrivateService({
      name,
      namespace: args.namespace,
      selector: { app: name },
      ports: endpoints,
      dependencies: [this.deployment],
      parent: this,
      aliases: childAliases,
      ipFamilyPolicy: args.ipFamilyPolicy,
      ipFamilies: args.ipFamilies,
    });

    const exposures = this.configureIngresses(name, args, endpoints, this.service, childAliases);
    this.ingresses = exposures.map(exposure => exposure.ingress);
    this.traefikPolicies = exposures.flatMap(exposure => exposure.policy ? [exposure.policy] : []);


    this.internalPolicies = endpoints.flatMap(endpoint => createPeerIngressPolicies({
      workloadName: name,
      namespace: args.namespace,
      podSelector: { app: name },
      containerPort: endpoint.containerPort,
      protocol: endpoint.protocol,
      rules: endpoint.allowIngressFrom,
      dependencies: [this.deployment],
      parent: this,
      aliases: childAliases,
    }));

    const volumeBackupJobs = createManagedVolumeBackups({
      appName: name,
      namespace: args.namespace,
      dependencies: [...dependencies, this.deployment],
      parent: this,
      aliases: childAliases,
    }, volConfig);
    this.backupJobs = [
      ...this.configureDatabaseBackups(name, args, dependencies, childAliases),
      ...volumeBackupJobs,
    ];

    const healthEndpoint = endpoints.find(endpoint => endpoint.healthCheck);
    if (healthEndpoint?.healthCheck) {
      this.healthProbe = createWorkloadHealthProbe({
        name,
        namespace: args.namespace,
        service: this.service,
        healthCheck: healthEndpoint.healthCheck,
        parent: this,
        aliases: childAliases,
      });
    }

    this.registerOutputs({});
  }


  private configureDeployment(
    name: string,
    args: SelfhostedAppArgs,
    endpoints: AppEndpoint[],
    envFrom: k8s.types.input.core.v1.EnvFromSource[],
    k8sVolumes: k8s.types.input.core.v1.Volume[],
    k8sVolumeMounts: k8s.types.input.core.v1.VolumeMount[],
    deploymentDeps: pulumi.Resource[],
    childOpts: pulumi.CustomResourceOptions,
    configChecksum?: pulumi.Output<string>,
    secretChecksum?: pulumi.Output<string>,
  ): k8s.apps.v1.Deployment {
    return new k8s.apps.v1.Deployment(name, {
      metadata: { name, namespace: args.namespace },
      spec: {
        replicas: 1,
        strategy: args.strategy as k8s.types.input.apps.v1.DeploymentStrategy,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: {
            labels: { app: name, ...(args.labels || {}) },
            annotations: {
              ...(configChecksum ? { "homelab.gdario.dev/config-checksum": configChecksum } : {}),
              ...(secretChecksum ? { "homelab.gdario.dev/secret-checksum": secretChecksum } : {}),
            },
          },
          spec: {
            serviceAccountName: args.serviceAccountName,
            automountServiceAccountToken: args.automountServiceAccountToken,
            runtimeClassName: args.runtimeClassName,
            nodeSelector: args.nodeSelector,
            securityContext: args.podSecurityContext,
            containers: [{
              name,
              image: args.image,
              imagePullPolicy: args.imagePullPolicy,
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
              securityContext: args.containerSecurityContext,
            }, ...(args.additionalContainers || [])],
            initContainers: args.initContainers,
            volumes: [...k8sVolumes, ...(args.additionalVolumes || [])],
            affinity: args.affinity,
          },
        },
      },
    }, { dependsOn: deploymentDeps, ...childOpts });
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
        name: endpoint.ingress.name || `${name}-${endpoint.name}`,
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


  private configureDatabaseBackups(
    name: string,
    args: SelfhostedAppArgs,
    dependencies: pulumi.Resource[],
    childAliases: pulumi.Alias[]
  ): k8s.batch.v1.CronJob[] {
    const jobs: k8s.batch.v1.CronJob[] = [];


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
