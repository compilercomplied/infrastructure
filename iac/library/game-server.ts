import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createManagedEnvironment } from "./workload-environment";
import { createWorkloadHealthProbe, WorkloadHealthCheck } from "./workload-health-probe";
import { PeerIngressRule, createPeerIngressPolicies } from "./workload-network-policy";
import { createPrivateService } from "./workload-service";
import { ManagedVolume, createManagedVolumeBackups, planManagedVolumes } from "./workload-volumes";

export type GameServerProtocol = "TCP" | "UDP" | "SCTP";

export interface GameServerEndpoint {
  name: string;
  containerPort: number;
  servicePort?: number;
  protocol: GameServerProtocol;
  allowIngressFrom?: PeerIngressRule[];
}

export interface GameServerArgs {
  namespace: pulumi.Input<string>;
  image: string;
  endpoints: [GameServerEndpoint, ...GameServerEndpoint[]];
  volumes?: ManagedVolume[];
  env?: k8s.types.input.core.v1.EnvVar[];
  config?: Record<string, pulumi.Input<string>>;
  secrets?: Record<string, pulumi.Input<string>>;
  command?: string[];
  args?: string[];
  resources: k8s.types.input.core.v1.ResourceRequirements;
  healthCheck?: WorkloadHealthCheck & { endpoint: string };
  labels?: Record<string, string>;
  dependencies?: pulumi.Resource[];
  affinity?: k8s.types.input.core.v1.Affinity;
  nodeSelector?: Record<string, pulumi.Input<string>>;
  podSecurityContext?: k8s.types.input.core.v1.PodSecurityContext;
  containerSecurityContext?: k8s.types.input.core.v1.SecurityContext;
  strategy?: k8s.types.input.apps.v1.DeploymentStrategy;
  readinessProbe?: k8s.types.input.core.v1.Probe;
  livenessProbe?: k8s.types.input.core.v1.Probe;
}

export class GameServer extends pulumi.ComponentResource {
  public readonly deployment: k8s.apps.v1.Deployment;
  public readonly service: k8s.core.v1.Service;
  public readonly configMap?: k8s.core.v1.ConfigMap;
  public readonly secret?: k8s.core.v1.Secret;
  public readonly pvcs: k8s.core.v1.PersistentVolumeClaim[];
  public readonly internalPolicies: k8s.networking.v1.NetworkPolicy[];
  public readonly backupJobs: k8s.batch.v1.CronJob[];
  public readonly healthProbe?: k8s.apiextensions.CustomResource;

  constructor(name: string, args: GameServerArgs, opts?: pulumi.ComponentResourceOptions) {
    super("custom:gameserver:GameServer", name, {}, opts);

    if (!args.resources.requests?.cpu || !args.resources.requests.memory || !args.resources.limits?.cpu || !args.resources.limits.memory) {
      throw new Error(`Game server ${name} requires CPU and memory requests and limits.`);
    }

    const dependencies = args.dependencies ?? [];

    const { configMap, secret, envFrom } = createManagedEnvironment({
      name,
      namespace: args.namespace,
      config: args.config,
      secrets: args.secrets,
      dependencies,
      parent: this,
    });
    this.configMap = configMap;
    this.secret = secret;

    const volumePlan = planManagedVolumes({
      appName: name,
      namespace: args.namespace,
      volumes: args.volumes,
      dependencies,
      parent: this,
    });
    this.pvcs = volumePlan.pvcs;

    const deploymentDependencies = [...dependencies, ...this.pvcs];
    if (configMap) {
      deploymentDependencies.push(configMap);
    }
    if (secret) {
      deploymentDependencies.push(secret);
    }

    this.deployment = new k8s.apps.v1.Deployment(name, {
      metadata: { name, namespace: args.namespace },
      spec: {
        replicas: 1,
        strategy: args.strategy,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name, ...(args.labels ?? {}) } },
          spec: {
            securityContext: args.podSecurityContext,
            nodeSelector: args.nodeSelector,
            affinity: args.affinity,
            containers: [{
              name,
              image: args.image,
              command: args.command,
              args: args.args,
              env: args.env ?? [],
              envFrom,
              ports: args.endpoints.map(endpoint => ({
                name: endpoint.name,
                containerPort: endpoint.containerPort,
                protocol: endpoint.protocol,
              })),
              volumeMounts: volumePlan.volumeMounts,
              readinessProbe: args.readinessProbe,
              livenessProbe: args.livenessProbe,
              resources: args.resources,
              securityContext: args.containerSecurityContext,
            }],
            volumes: volumePlan.volumes,
          },
        },
      },
    }, { dependsOn: deploymentDependencies, parent: this });

    this.service = createPrivateService({
      name,
      namespace: args.namespace,
      selector: { app: name },
      ports: args.endpoints,
      dependencies: [this.deployment],
      parent: this,
    });

    this.internalPolicies = args.endpoints.flatMap(endpoint => createPeerIngressPolicies({
      workloadName: name,
      namespace: args.namespace,
      podSelector: { app: name },
      containerPort: endpoint.containerPort,
      protocol: endpoint.protocol,
      rules: endpoint.allowIngressFrom,
      dependencies: [this.deployment],
      parent: this,
    }));

    this.backupJobs = createManagedVolumeBackups({
      appName: name,
      namespace: args.namespace,
      dependencies: [...dependencies, this.deployment],
      parent: this,
    }, volumePlan);

    if (args.healthCheck) {
      const endpoint = args.endpoints.find(candidate => candidate.name === args.healthCheck?.endpoint);
      if (!endpoint) {
        throw new Error(`Game server ${name} health check targets undeclared endpoint ${args.healthCheck.endpoint}.`);
      }
      this.healthProbe = createWorkloadHealthProbe({
        name,
        namespace: args.namespace,
        service: this.service,
        healthCheck: {
          protocol: args.healthCheck.protocol,
          ...(args.healthCheck.protocol === "http" ? { path: args.healthCheck.path } : {}),
          interval: args.healthCheck.interval,
          servicePort: endpoint.servicePort ?? endpoint.containerPort,
        },
        parent: this,
        aliases: [],
      });
    }

    this.registerOutputs({});
  }
}
