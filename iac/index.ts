import * as pulumi from "@pulumi/pulumi";
import { configureTailscale } from "./platform/tailscale";
import { configurePrivateAccess } from "./platform/private-access";
import { configureMonitoring } from "./workloads/monitoring";
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
import { configureKvmDevicePlugin } from "./platform/core/kvm-device-plugin";
import { configureCodexDesktop } from "./workloads/selfhosted/codex-desktop";
import { configureKeycloakIdentities } from "./platform/core/keycloak/identities";
import { createAgentIdentities } from "./library/agent-identity";

const agentIdentities = createAgentIdentities();
const tailscale = configureTailscale();
const certManager = configureCertManager();
const kvmDevicePlugin = configureKvmDevicePlugin();
const codexDesktop = configureCodexDesktop(tailscale, certManager.letsEncryptProd, kvmDevicePlugin, agentIdentities.codex);
configurePrivateAccess(tailscale, codexDesktop ? [codexDesktop.dnsRecord] : []);
configureMonitoring();

configureMaintenance();

const sharedResources = configureSharedResources();

const selfhosted = configureSelfhosted(sharedResources.postgres, sharedResources.mariadb);
const infrastructure = configureInfrastructure([sharedResources.postgres]);
export const keycloakUrl = infrastructure.keycloak.url;
export const keycloakAutomationClientId = infrastructure.keycloak.automationClientId;
export const keycloakAutomationClientSecret = pulumi.secret(infrastructure.keycloak.automationSecret);
const identities = configureKeycloakIdentities(infrastructure.keycloak, agentIdentities);
export const keycloakIssuer = identities.issuer;
export const keycloakGoogleCallback = identities.googleCallback;
export const keycloakAccountUrl = identities.accountUrl;

configureForgejo({
  dario: identities.humanSubjects.gdario,
  codex: identities.agentSubjects[agentIdentities.codex.username],
  hermes: identities.agentSubjects[agentIdentities.hermes.username],
  codingBot: identities.agentSubjects[agentIdentities.codingBot.username],
  reviewingBot: identities.agentSubjects[agentIdentities.reviewingBot.username],
  renovate: identities.agentSubjects[agentIdentities.renovate.username],
}, [sharedResources.postgres]);

const gamePlatform = new GamePlatform("games");
configureMinecraft(gamePlatform);

const directDnsConfig = new pulumi.Config("selfhosted");
const directDnsRecords = [
  ...(directDnsConfig.getObject<{ owner: string; hostname: string }[]>("directDnsRecords") ?? []),
  ...gamePlatform.directDnsRecords(),
];
if (directDnsRecords.length > 0) {
  const publicIpv4Endpoint = directDnsConfig.get("directDnsPublicIpv4Endpoint");
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

configureAgentSidekicks(selfhosted, kvmDevicePlugin, agentIdentities.hermes);
