import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createManagedEnvironment } from "./workload-environment";
import { LetsEncryptIngressResult, RateLimitConfig, createLetsEncryptIngress } from "./ingress";
import { createWorkloadHealthProbe, WorkloadHealthCheck } from "./workload-health-probe";
import { PeerIngressRule, createPeerIngressPolicies } from "./workload-network-policy";
import { createPrivateService } from "./workload-service";
import { createManagedVolumeBackups, planManagedVolumes } from "./workload-volumes";

export type GameServerProtocol = "TCP" | "UDP" | "SCTP";

export interface GameServerEndpoint {
  name: string;
  hostname?: string;
  containerPort: number;
  servicePort?: number;
  protocol: GameServerProtocol;
  exposeOnLan?: boolean;
  allowIngressFrom?: PeerIngressRule[];
}

export interface GameServerHttpIngress {
  name: string;
  host: string;
  endpoint: string;
  rateLimit?: RateLimitConfig | false;
}

export interface GameServerLanEndpoint {
  name: string;
  protocol: GameServerProtocol;
  servicePort: number;
}

export interface GameServerStorageMount {
  mountPath: string;
  subPath?: string;
}

export interface GameServerStorage {
  name: string;
  mounts: [GameServerStorageMount, ...GameServerStorageMount[]];
  size?: string;
  storageClassName?: string;
  accessModes?: string[];
  pvcName?: string;
  enableBackup?: boolean;
}

export interface GameServerArgs {
  namespace: pulumi.Input<string>;
  image: string;
  endpoints: [GameServerEndpoint, ...GameServerEndpoint[]];
  httpIngresses?: GameServerHttpIngress[];
  storage: [GameServerStorage, ...GameServerStorage[]];
  env?: k8s.types.input.core.v1.EnvVar[];
  config?: Record<string, pulumi.Input<string>>;
  secrets?: Record<string, pulumi.Input<string>>;
  command?: string[];
  args?: string[];
  resources: k8s.types.input.core.v1.ResourceRequirements;
  healthCheck?: Extract<WorkloadHealthCheck, { protocol: "tcp" }> & { endpoint: string };
  service: string;
  labels?: Record<string, string>;
  dependencies?: pulumi.Resource[];
  affinity?: k8s.types.input.core.v1.Affinity;
  nodeSelector?: Record<string, pulumi.Input<string>>;
  podSecurityContext?: k8s.types.input.core.v1.PodSecurityContext;
  containerSecurityContext?: k8s.types.input.core.v1.SecurityContext;

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
  public readonly lanService?: k8s.core.v1.Service;
  public readonly lanEndpoints: readonly GameServerLanEndpoint[];
  public readonly lanPolicies: k8s.networking.v1.NetworkPolicy[];
  public readonly httpIngresses: LetsEncryptIngressResult[];
  public readonly backupJobs: k8s.batch.v1.CronJob[];
  public readonly healthProbe?: k8s.apiextensions.CustomResource;

  constructor(name: string, args: GameServerArgs, opts?: pulumi.ComponentResourceOptions) {
    super("custom:gameserver:GameServer", name, {}, opts);

    if (!args.resources.requests || !args.resources.limits) {
      throw new Error(`Game server ${name} requires CPU and memory requests and limits.`);
    }

    if (args.storage.some(storage => storage.enableBackup === false && storage.mounts.some(mount => !mount.subPath))) {
      throw new Error(`Game server ${name} can disable backups only for storage mounted through subPaths.`);
    }
    if (args.storage.some(storage => storage.mounts.some(mount => !mount.mountPath || mount.mountPath === "/"))) {
      throw new Error(`Game server ${name} storage mounts require non-root mount paths.`);
    }
    if (args.storage.some(storage => storage.mounts.some(mount => mount.subPath?.startsWith("/")))) {
      throw new Error(`Game server ${name} storage subPaths must be relative paths.`);
    }
    if (args.storage.some(storage => storage.mounts.some(mount => mount.subPath?.split("/").includes("..")))) {
      throw new Error(`Game server ${name} storage subPaths must not traverse parent directories.`);
    }
    if (args.storage.some(storage => storage.mounts.length > 1 && storage.mounts.some(mount => !mount.subPath))) {
      throw new Error(`Game server ${name} shared storage mounts require subPaths on every mount.`);
    }

    if (new Set(args.storage.map(storage => storage.name)).size !== args.storage.length) {
      throw new Error(`Game server ${name} storage names must be unique.`);
    }
    if (new Set(args.storage.flatMap(storage => storage.mounts.map(mount => mount.mountPath))).size !== args.storage.flatMap(storage => storage.mounts.map(mount => mount.mountPath)).length) {
      throw new Error(`Game server ${name} storage mount paths must be unique.`);
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
      volumes: args.storage.map(storage => ({
        name: storage.name,
        mountPath: storage.mounts[0].mountPath,
        size: storage.size,
        storageClassName: storage.storageClassName,
        accessModes: storage.accessModes,
        pvcName: storage.pvcName,
        enableBackup: storage.enableBackup,
      })),
      dependencies,
      parent: this,
    });
    volumePlan.volumeMounts.splice(0, volumePlan.volumeMounts.length, ...args.storage.flatMap(storage => storage.mounts.map(mount => ({
      name: storage.name,
      mountPath: mount.mountPath,
      subPath: mount.subPath,
    }))));
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
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name, service: args.service, ...(args.labels ?? {}) } },
          spec: {
            securityContext: args.podSecurityContext,
            nodeSelector: args.nodeSelector,
            affinity: args.affinity,
            initContainers: args.storage.some(storage => storage.mounts.some(mount => mount.subPath)) ? [{
              name: "init-storage",
              image: "docker.io/library/busybox@sha256:b7f3d86d6e84fc17718c48bcde1450807faa2d56704205c697b4bd5df7b9e29f",
              command: ["sh", "-c", args.storage.flatMap(storage => storage.mounts.map(mount => mount.subPath)).filter((subPath): subPath is string => Boolean(subPath)).map(subPath => `mkdir -p /data/${subPath}`).join(" && ")],
              volumeMounts: args.storage.filter(storage => storage.mounts.some(mount => mount.subPath)).map(storage => ({ name: storage.name, mountPath: "/data" })),
              resources: { requests: { cpu: "1m", memory: "4Mi" }, limits: { cpu: "10m", memory: "16Mi" } },
            }] : undefined,
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

    this.httpIngresses = (args.httpIngresses ?? []).map(httpIngress => {
      const endpoint = args.endpoints.find(candidate => candidate.name === httpIngress.endpoint);
      if (!endpoint) {
        throw new Error(`Game server ${name} HTTP ingress targets undeclared endpoint ${httpIngress.endpoint}.`);
      }

      return createLetsEncryptIngress({
        name: httpIngress.name,
        namespace: args.namespace,
        host: httpIngress.host,
        serviceName: this.service.metadata.name,
        servicePort: endpoint.servicePort ?? endpoint.containerPort,
        rateLimit: httpIngress.rateLimit,
        dependencies: [this.service],
        parent: this,
        targetPort: endpoint.containerPort,
        podSelector: { app: name },
      });
    });

    const lanEndpoints = args.endpoints.filter(endpoint => endpoint.exposeOnLan !== false);
    this.lanEndpoints = lanEndpoints.map(endpoint => ({
      name: endpoint.name,
      protocol: endpoint.protocol,
      servicePort: endpoint.servicePort ?? endpoint.containerPort,
    }));
    if (lanEndpoints.length > 0) {
      this.lanService = new k8s.core.v1.Service(`${name}-lan`, {
        metadata: { name: `${name}-lan`, namespace: args.namespace },
        spec: {
          type: "LoadBalancer",
          selector: { app: name },
          ports: lanEndpoints.map(endpoint => ({
            name: `${endpoint.name}-${endpoint.protocol.toLowerCase()}`,
            protocol: endpoint.protocol,
            port: endpoint.servicePort ?? endpoint.containerPort,
            targetPort: endpoint.containerPort,
          })),
        },
      }, { dependsOn: this.deployment, parent: this });

      this.lanPolicies = lanEndpoints.map(endpoint => new k8s.networking.v1.NetworkPolicy(`${name}-allow-${endpoint.name}`, {
        metadata: { name: `${name}-allow-${endpoint.name}`, namespace: args.namespace },
        spec: {
          podSelector: { matchLabels: { app: name } },
          ingress: [{
            ports: [{ protocol: endpoint.protocol, port: endpoint.containerPort }],
          }],
          policyTypes: ["Ingress"],
        },
      }, { dependsOn: this.deployment, parent: this }));
    } else {
      this.lanPolicies = [];
    }

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
          protocol: "tcp",
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
