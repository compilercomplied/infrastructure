import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { configureDocker } from "./platform/docker";
import { configureMonitoring } from "./workloads/monitoring";
import { configureAgents } from "./workloads/agents/control-plane-index";
import { configureMaintenance } from "./operations/maintenance";
import { configureSelfhosted } from "./workloads/selfhosted";
import { configureCertManager } from "./platform/cert-manager";
import { configureInfrastructure } from "./platform/core";
import { configureSharedResources } from "./platform/shared-resources";
import { configureForgejo } from "./workloads/forgejo";
import { configureAgentSidekicks } from "./workloads/agents";
import { DirectDnsReconciler } from "./library/direct-dns-reconciler";
import { GamePlatform } from "./library/game-platform";
import { configureMinecraft } from "./workloads/games/minecraft";

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
// Disable minecraft server. Pending better way to tackle server toggling.
// configureMinecraft(gamePlatform);

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
