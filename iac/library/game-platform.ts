import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GameServer, GameServerArgs, GameServerProtocol } from "./game-server";
import { configureNamespaceSecurity } from "../selfhosted/security";
import { DirectDnsRegistration } from "./direct-dns-reconciler";

export interface PublicL4Registration {
  owner: string;
  hostname: string;
  protocol: GameServerProtocol;
  port: number;
  endpoint: string;
  namespace: pulumi.Input<string>;
  serviceName: pulumi.Input<string>;
  servicePort: number;
}

interface PublicL4Claim {
  hostname: string;
  protocol: GameServerProtocol;
  port: number;
  endpoint: string;
}

export type GamePlatformServerArgs = Omit<GameServerArgs, "namespace" | "dependencies">;

export class GamePlatform extends pulumi.ComponentResource {
  private readonly servers = new Map<string, GameServer>();
  private readonly directDnsOwners = new Map<string, string>();
  private readonly directDnsRegistrations: DirectDnsRegistration[] = [];
  private readonly publicL4Owners = new Map<string, string>();
  private readonly publicL4Registrations: PublicL4Registration[] = [];

  constructor(name: string, opts?: pulumi.ComponentResourceOptions) {
    super("custom:gameserver:Platform", name, {}, opts);
    this.registerOutputs({});
  }

  public addServer(name: string, args: GamePlatformServerArgs): GameServer {
    const namespaceName = this.namespaceName(name);
    if (this.servers.has(name)) {
      throw new Error(`Game server ${name} is already defined by this platform.`);
    }
    const namespace = new k8s.core.v1.Namespace(namespaceName, {
      metadata: { name: namespaceName },
    }, { parent: this });

    const security = configureNamespaceSecurity({
      namespace: namespace.metadata.name,
      dependencies: [namespace],
      namePrefix: `${namespaceName}-`,
      allowMonitoringScrape: false,
      allowCertManagerSolver: false,
    });

    const server = new GameServer(name, {
      ...args,
      namespace: namespace.metadata.name,
      dependencies: [namespace, security.defaultDeny],
    }, { parent: this });

    for (const endpoint of args.endpoints) {
      if (endpoint.hostname) {
        this.registerPublicL4(name, namespace.metadata.name, server, {
          hostname: endpoint.hostname,
          protocol: endpoint.protocol,
          port: endpoint.servicePort ?? endpoint.containerPort,
          endpoint: endpoint.name,
        });
      }
    }

    this.servers.set(name, server);
    return server;
  }

  public directDnsRecords(): readonly DirectDnsRegistration[] {
    return [...this.directDnsRegistrations];
  }

  public publicL4Records(): readonly PublicL4Registration[] {
    return [...this.publicL4Registrations];
  }

  private registerPublicL4(
    owner: string,
    namespace: pulumi.Input<string>,
    server: GameServer,
    claim: PublicL4Claim,
  ): void {
    const normalizedHostname = this.normalizeHostname(owner, claim.hostname, "public L4");
    if (!Number.isInteger(claim.port) || claim.port < 1 || claim.port > 65535) {
      throw new Error(`Game server ${owner} public L4 port ${claim.port} must be an integer between 1 and 65535.`);
    }
    const endpoint = server.lanEndpoints.find(candidate => candidate.name === claim.endpoint);
    if (!endpoint) {
      throw new Error(`Game server ${owner} public L4 claim targets undeclared endpoint ${claim.endpoint}.`);
    }
    if (endpoint.protocol !== claim.protocol) {
      throw new Error(`Game server ${owner} public L4 claim protocol ${claim.protocol} does not match endpoint ${claim.endpoint} protocol ${endpoint.protocol}.`);
    }
    if (endpoint.servicePort !== claim.port) {
      throw new Error(`Game server ${owner} public L4 claim port ${claim.port} does not match endpoint ${claim.endpoint} ServiceLB port ${endpoint.servicePort}.`);
    }
    if (!server.lanService) {
      throw new Error(`Game server ${owner} public L4 claim requires a component-owned LAN LoadBalancer Service.`);
    }

    const portKey = `${claim.protocol}/${claim.port}`;
    const conflictingPortOwner = this.publicL4Owners.get(portKey);
    if (conflictingPortOwner) {
      throw new Error(`Public L4 ${portKey} is already owned by game server ${conflictingPortOwner}.`);
    }
    this.registerDirectDns(owner, normalizedHostname);
    this.publicL4Owners.set(portKey, owner);
    this.publicL4Registrations.push({
      owner,
      hostname: normalizedHostname,
      protocol: claim.protocol,
      port: claim.port,
      endpoint: claim.endpoint,
      namespace,
      serviceName: server.lanService.metadata.name,
      servicePort: endpoint.servicePort,
    });
  }

  private registerDirectDns(owner: string, hostname: string): void {
    const normalizedHostname = this.normalizeHostname(owner, hostname, "direct DNS");
    const conflictingOwner = this.directDnsOwners.get(normalizedHostname);
    if (conflictingOwner) {
      throw new Error(`Direct DNS hostname ${hostname} is already owned by game server ${conflictingOwner}.`);
    }
    this.directDnsOwners.set(normalizedHostname, owner);
    this.directDnsRegistrations.push({ owner, hostname: normalizedHostname });
  }

  private normalizeHostname(owner: string, hostname: string, purpose: string): string {
    const normalizedHostname = hostname.toLowerCase();
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalizedHostname)) {
      throw new Error(`Game server ${owner} ${purpose} hostname ${hostname} must be a valid fully-qualified DNS name.`);
    }
    return normalizedHostname;
  }

  private namespaceName(name: string): string {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
      throw new Error(`Game server name ${name} must be a DNS-1123 label.`);
    }
    return `game-${name}`;
  }
}
