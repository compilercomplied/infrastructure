import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createPVC } from "../../library/k8s-pvc";
import { configureTandoorRecipes } from "./tandoor-recipes";

import { configureLinkwarden } from "./linkwarden";
import { configureOutline } from "./outline";
import { configureGrimmory } from "./grimmory";
import { configureMemos } from "./memos";
import { configureWindshift } from "./windshift";
import { configureExcaliDash } from "./excalidash";
import { configureDoop } from "./doop";
import { configurePulp } from "./pulp";
import { configureNamespaceSecurity } from "./security";
import { configureCoreDnsCustom } from "../../platform/core/coredns";
import { configureCloudflared } from "./cloudflared";
import { configureNtfy } from "./ntfy";

export function configureSelfhosted(postgres: k8s.core.v1.Service, mariadb: k8s.core.v1.Service) {
  const namespace = new k8s.core.v1.Namespace("selfhosted", {
    metadata: { name: "selfhosted" }
  });

  const namespaceName = namespace.metadata.name;

  const config = new pulumi.Config("selfhosted");
  const cloudflareTunnelToken = config.requireSecret("cloudflareTunnelToken");

	// Deployments
  const tandoor = configureTandoorRecipes(namespaceName, [postgres]);
  const linkwarden = configureLinkwarden(namespaceName, [postgres]);
  const grimmory = configureGrimmory(namespaceName, mariadb, [postgres]);
  const outline = configureOutline(namespaceName, [postgres]);
  const ntfy = configureNtfy(namespaceName);
  const memos = configureMemos(namespaceName, [postgres]);
  const windshift = configureWindshift(namespaceName);
  const excalidash = configureExcaliDash(namespaceName, [postgres]);
  const doop = configureDoop(namespaceName, [postgres]);
  const pulp = configurePulp(namespaceName, [postgres]);
  // Keep retired Syncthing data available for recovery without retaining a running sync service.
  createPVC({
    name: "syncthing-data-pvc",
    namespace: namespaceName,
    size: "2Gi",
    protect: true,
    aliases: [{ parent: pulumi.createUrn("syncthing", "custom:selfhosted:App") }],
  });

  const security = configureNamespaceSecurity({
    namespace: namespaceName,
    dependencies: [postgres, tandoor.deployment, linkwarden.deployment, grimmory.deployment, outline.outline.deployment, ntfy.deployment, memos.deployment, windshift.deployment, excalidash.deployment, doop.deployment, pulp.deployment],
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
    linkwarden,
    grimmory,
    outline,
    ntfy,
    memos,
    windshift,
    excalidash,
    doop,
    pulp,
    corednsCustom,
    cloudflared,
    defaultDeny: security.defaultDeny,
    allowMonitoringScrape: security.allowMonitoringScrape,
    allowCertManagerSolver: security.allowCertManagerSolver,
  };
}
