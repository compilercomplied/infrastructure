import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { configureSharedPostgres } from "./shared-postgres";
import { configureTandoorRecipes } from "./tandoor-recipes";
import { configureAuthentik } from "./authentik";
import { configureLinkwarden } from "./linkwarden";
import { HermesAgent } from "../components/hermes/hermes-agent";
import { configureTandoorMcp } from "./tandoor-mcp";
import { configureGrimmory } from "./grimmory";
import { configureGrafanaMcp } from "./grafana-mcp";
import { configureSyncthing } from "./syncthing";
import { configureFilesystemMcp } from "./filesystem-mcp";
import { configureKubernetesMcp } from "./kubernetes-mcp";
import { configureForgejoMcp } from "./forgejo-mcp";
import { configureNamespaceSecurity } from "./security";
import { configureCoreDnsCustom } from "./coredns";
import { configureCloudflared } from "./cloudflared";
import { configureForgejo } from "./forgejo";

export function configureSelfhosted() {
  const namespace = new k8s.core.v1.Namespace("selfhosted", {
    metadata: { name: "selfhosted" }
  });

  const namespaceName = namespace.metadata.name;

  const config = new pulumi.Config("selfhosted");
  const tandoorDbPassword = config.requireSecret("tandoorDbPassword");
  const authentikDbPassword = config.requireSecret("authentikDbPassword");
  const linkwardenDbPassword = config.requireSecret("linkwardenDbPassword");
  const forgejoDbPassword = config.requireSecret("forgejoDbPassword");
  const cloudflareTunnelToken = config.requireSecret("cloudflareTunnelToken");

	// Deployments
  const postgres = configureSharedPostgres(namespaceName, [
    { name: "tandoor", password: tandoorDbPassword },
    { name: "authentik", password: authentikDbPassword },
    { name: "linkwarden", password: linkwardenDbPassword },
    { name: "forgejo", password: forgejoDbPassword },
  ]);
  const tandoor = configureTandoorRecipes(namespaceName, [postgres]);
  const tandoorMcp = configureTandoorMcp(namespaceName, [postgres, tandoor.deployment]);
  const authentik = configureAuthentik(namespaceName, [postgres]);
  const linkwarden = configureLinkwarden(namespaceName, [postgres]);
  const grimmory = configureGrimmory(namespaceName, [postgres]);
  const forgejo = configureForgejo(namespaceName, [postgres]);
  const grafanaMcp = configureGrafanaMcp(namespaceName, [postgres]);
  // Since Syncthing mounts Grimmory's bookdrop PVC externally, it has a runtime dependency
  // on Grimmory's volume being created first. We pass grimmory.deployment as a dependency.
  const syncthing = configureSyncthing(namespaceName, [authentik.serverService, grimmory.deployment]);
  const filesystemMcp = configureFilesystemMcp(namespaceName, [syncthing.deployment]);
  const kubernetesMcp = configureKubernetesMcp(namespaceName, [postgres]);
  const forgejoMcp = configureForgejoMcp(namespaceName, [postgres, forgejo.deployment]);
  const hermes = new HermesAgent("hermes-agent", {
    namespace: namespaceName,
    dependencies: [postgres, authentik.serverService, tandoorMcp.service, grafanaMcp.service, filesystemMcp.service, kubernetesMcp.service, forgejoMcp.service],
  });

  const security = configureNamespaceSecurity({
    namespace: namespaceName,
    dependencies: [postgres, tandoor.deployment, authentik.workerDeployment, linkwarden.deployment, grimmory.deployment, syncthing.deployment, hermes.deployment, forgejo.deployment, kubernetesMcp.deployment, forgejoMcp.deployment],
  });

  const cloudflared = configureCloudflared(namespaceName, cloudflareTunnelToken, [security.defaultDeny]);

  // Configure custom CoreDNS overrides for gdario.dev routing inside the cluster.
  // This depends on no explicit resources as Traefik is pre-installed by the K3s runtime.
  const corednsCustom = configureCoreDnsCustom([]);

  return {
    namespace: namespaceName,
    postgres,
    tandoor,
    tandoorMcp,
    authentik,
    linkwarden,
    grimmory,
    forgejo,
    grafanaMcp,
    hermes,
    syncthing,
    filesystemMcp,
    kubernetesMcp,
    forgejoMcp,
    corednsCustom,
    cloudflared,
    defaultDeny: security.defaultDeny,
    allowMonitoringScrape: security.allowMonitoringScrape,
    allowCertManagerSolver: security.allowCertManagerSolver,
  };
}
