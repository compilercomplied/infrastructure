import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { configureDocker } from "./modules/docker";
import { configureMonitoring } from "./monitoring";
import { configureAgents } from "./modules/agents";
import { configureMaintenance } from "./modules/maintenance";
import { configureSelfhosted } from "./selfhosted";
import { configureCertManager } from "./modules/cert-manager";
import { configureInfrastructure } from "./infrastructure";
import { configureSharedResources } from "./shared-resources";
import { configureForgejo } from "./forgejo";
import { configureAgentSidekicks } from "./agent-sidekicks";
import { DirectDnsReconciler } from "./library/direct-dns-reconciler";
import { GamePlatform } from "./library/game-platform";
import { configureMinecraft } from "./games/minecraft";

const { namespace } = configureAgents();

configureDocker(namespace);
configureMonitoring();

configureCertManager();
configureMaintenance();

// Phase 1: Initialize new namespaces (no workloads migrated yet)
const sharedResources = configureSharedResources();

const selfhosted = configureSelfhosted(sharedResources.postgres, sharedResources.mariadb);
const infrastructure = configureInfrastructure();

const forgejo = configureForgejo([sharedResources.postgres]);

const gamePlatform = new GamePlatform("games");
configureMinecraft(gamePlatform);

const directDnsConfig = new pulumi.Config("selfhosted");
const directDnsRecords = [
  ...(directDnsConfig.getObject<{ owner: string; hostname: string }[]>("directDnsRecords") ?? []),
  ...gamePlatform.directDnsRecords(),
];
if (directDnsRecords.length > 0) {
  const publicIpv4Endpoint = directDnsConfig.get("directDnsPublicIpv4Endpoint") ?? "https://api.ipify.org";
  const intervalSeconds = directDnsConfig.getNumber("directDnsIntervalSeconds") ?? 300;
  new DirectDnsReconciler("direct-dns-reconciler", {
    namespace: selfhosted.namespace,
    zoneId: directDnsConfig.require("cloudflareZoneId"),
    apiToken: directDnsConfig.requireSecret("cloudflareApiToken"),
    records: directDnsRecords,
    publicIpv4Endpoint,
    intervalSeconds,
    dependencies: [selfhosted.defaultDeny],
  });
}

// Phase 2: Stateless Agent & MCP Migration
const sidekicks = configureAgentSidekicks(selfhosted);
