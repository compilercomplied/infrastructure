import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { configureSharedPostgres } from "./shared-postgres";
import { configureTandoorRecipes } from "./tandoor-recipes";
import { configureAuthentik } from "./authentik";
import { configureLinkwarden } from "./linkwarden";
import { configureOutline } from "./outline";
import { configureGrimmory } from "./grimmory";
import { configureSyncthing } from "./syncthing";
import { configureNamespaceSecurity } from "./security";
import { configureCoreDnsCustom } from "./coredns";
import { configureCloudflared } from "./cloudflared";
import { configureForgejo } from "./forgejo";
import { configureForgejoRunner } from "./forgejo-runner";

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
  const litellmDbPassword = config.requireSecret("litellmDbPassword");
  const cloudflareTunnelToken = config.requireSecret("cloudflareTunnelToken");

	// Deployments
  const postgres = configureSharedPostgres(namespaceName, [
    { name: "tandoor", password: tandoorDbPassword },
    { name: "authentik", password: authentikDbPassword },
    { name: "linkwarden", password: linkwardenDbPassword },
    { name: "forgejo", password: forgejoDbPassword },
    { name: "litellm", password: litellmDbPassword },
    { name: "outline", password: config.requireSecret("outlineDbPassword") },
  ]);
  const tandoor = configureTandoorRecipes(namespaceName, [postgres]);
  const authentik = configureAuthentik(namespaceName, [postgres]);
  const linkwarden = configureLinkwarden(namespaceName, [postgres]);
  const grimmory = configureGrimmory(namespaceName, [postgres]);
  const outline = configureOutline(namespaceName, [postgres]);
  const forgejo = configureForgejo(namespaceName, [postgres]);
  // Since Syncthing mounts Grimmory's bookdrop PVC externally, it has a runtime dependency
  // on Grimmory's volume being created first. We pass grimmory.deployment as a dependency.
  const syncthing = configureSyncthing(namespaceName, [authentik.serverService, grimmory.deployment]);
  const forgejoRunner = configureForgejoRunner(namespaceName, forgejo.runnerSecret, [forgejo.deployment]);

  const security = configureNamespaceSecurity({
    namespace: namespaceName,
    dependencies: [postgres, tandoor.deployment, authentik.workerDeployment, linkwarden.deployment, grimmory.deployment, syncthing.deployment, forgejo.deployment, forgejoRunner.deployment, outline.outline.deployment],
    namePrefix: "selfhosted-",
    aliases: {
      defaultDeny: [{ name: "default-deny-ingress" }],
      monitoring: [{ name: "allow-monitoring-scrape" }],
      certManager: [{ name: "allow-cert-manager-solver" }],
    },
  });

  const cloudflared = configureCloudflared(namespaceName, cloudflareTunnelToken, [security.defaultDeny]);

  // Configure custom CoreDNS overrides for gdario.dev routing inside the cluster.
  // This depends on no explicit resources as Traefik is pre-installed by the K3s runtime.
  const corednsCustom = configureCoreDnsCustom([]);

  return {
    namespace: namespaceName,
    postgres,
    tandoor,
    authentik,
    linkwarden,
    grimmory,
    outline,
    forgejo,
    forgejoRunner,
    syncthing,
    corednsCustom,
    cloudflared,
    defaultDeny: security.defaultDeny,
    allowMonitoringScrape: security.allowMonitoringScrape,
    allowCertManagerSolver: security.allowCertManagerSolver,
  };
}
