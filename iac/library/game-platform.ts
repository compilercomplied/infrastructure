import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GameServer, GameServerArgs } from "./game-server";
import { configureNamespaceSecurity } from "../selfhosted/security";

export class GamePlatform extends pulumi.ComponentResource {
  private readonly servers = new Map<string, GameServer>();

  constructor(name: string, opts?: pulumi.ComponentResourceOptions) {
    super("custom:gameserver:Platform", name, {}, opts);
    this.registerOutputs({});
  }

  public addServer(name: string, args: Omit<GameServerArgs, "namespace" | "dependencies">): GameServer {
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

    this.servers.set(name, server);
    return server;
  }

  private namespaceName(name: string): string {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
      throw new Error(`Game server name ${name} must be a DNS-1123 label.`);
    }
    return `game-${name}`;
  }
}
