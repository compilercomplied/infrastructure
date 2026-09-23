import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GameServer, GameServerArgs } from "./game-server";
import { configureNamespaceSecurity } from "../selfhosted/security";
import { DirectDnsRegistration } from "./direct-dns-reconciler";

export interface GameServerDnsArgs {
  hostname: string;
}

export type GamePlatformServerArgs = Omit<GameServerArgs, "namespace" | "dependencies"> & {
  directDns?: GameServerDnsArgs;
};

export class GamePlatform extends pulumi.ComponentResource {
  private readonly servers = new Map<string, GameServer>();
  private readonly directDnsOwners = new Map<string, string>();
  private readonly directDnsRegistrations: DirectDnsRegistration[] = [];

  constructor(name: string, opts?: pulumi.ComponentResourceOptions) {
    super("custom:gameserver:Platform", name, {}, opts);
    this.registerOutputs({});
  }

  public addServer(name: string, args: GamePlatformServerArgs): GameServer {
    const namespaceName = this.namespaceName(name);
    if (this.servers.has(name)) {
      throw new Error(`Game server ${name} is already defined by this platform.`);
    }
    if (args.directDns) {
      this.registerDirectDns(name, args.directDns.hostname);
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

    this.servers.set(name, server);
    return server;
  }

  public directDnsRecords(): readonly DirectDnsRegistration[] {
    return [...this.directDnsRegistrations];
  }

  private registerDirectDns(owner: string, hostname: string): void {
    const normalizedHostname = hostname.toLowerCase();
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalizedHostname)) {
      throw new Error(`Game server ${owner} direct DNS hostname ${hostname} must be a valid fully-qualified DNS name.`);
    }
    const conflictingOwner = this.directDnsOwners.get(normalizedHostname);
    if (conflictingOwner) {
      throw new Error(`Direct DNS hostname ${hostname} is already owned by game server ${conflictingOwner}.`);
    }
    this.directDnsOwners.set(normalizedHostname, owner);
    this.directDnsRegistrations.push({ owner, hostname: normalizedHostname });
  }

  private namespaceName(name: string): string {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
      throw new Error(`Game server name ${name} must be a DNS-1123 label.`);
    }
    return `game-${name}`;
  }
}
