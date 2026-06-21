import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { configureSharedPostgres } from "./shared-postgres";
import { configureTandoorRecipes } from "./tandoor-recipes";
import { configureAuthentik } from "./authentik";
import { configureAuthentikResources } from "./authentik-resources";
import { configureLinkwarden } from "./linkwarden";
import { HermesAgent } from "../components/hermes/hermes-agent";
import { configureTandoorMcp } from "./tandoor-mcp";
import { configureGrimmory } from "./grimmory";
import { configureGrafanaMcp } from "./grafana-mcp";
import { configureSyncthing } from "./syncthing";
import { configureFilesystemMcp } from "./filesystem-mcp";

export function configureSelfhosted() {
  const namespace = new k8s.core.v1.Namespace("selfhosted", {
    metadata: { name: "selfhosted" }
  });

  const namespaceName = namespace.metadata.name;

  const config = new pulumi.Config("selfhosted");
  const tandoorDbPassword = config.requireSecret("tandoorDbPassword");
  const authentikDbPassword = config.requireSecret("authentikDbPassword");
  const linkwardenDbPassword = config.requireSecret("linkwardenDbPassword");

	// Deployments
  const postgres = configureSharedPostgres(namespaceName, [
    { name: "tandoor", password: tandoorDbPassword },
    { name: "authentik", password: authentikDbPassword },
    { name: "linkwarden", password: linkwardenDbPassword },
  ]);
  const tandoor = configureTandoorRecipes(namespaceName, [postgres]);
  const tandoorMcp = configureTandoorMcp(namespaceName, [postgres, tandoor.deployment]);
  const authentik = configureAuthentik(namespaceName, [postgres]);
  const linkwarden = configureLinkwarden(namespaceName, [postgres]);
  const grimmory = configureGrimmory(namespaceName, [postgres]);
  const grafanaMcp = configureGrafanaMcp(namespaceName, [postgres]);
  // Since Syncthing mounts Grimmory's bookdrop PVC externally, it has a runtime dependency
  // on Grimmory's volume being created first. We pass grimmory.deployment as a dependency.
  const syncthing = configureSyncthing(namespaceName, [authentik.serverService, grimmory.deployment]);
  const filesystemMcp = configureFilesystemMcp(namespaceName, [syncthing.deployment]);
  const hermes = new HermesAgent("hermes-agent", {
    namespace: namespaceName,
    dependencies: [postgres, authentik.serverService, tandoorMcp.service, grafanaMcp.service, filesystemMcp.service],
  });

  // Declarative SSO Applications & Providers configuration
  const authentikResources = configureAuthentikResources(namespaceName);

  return {
    namespace: namespaceName,
    postgres,
    tandoor,
    tandoorMcp,
    authentik,
    linkwarden,
    grimmory,
    grafanaMcp,
    hermes,
    authentikResources,
    syncthing,
    filesystemMcp,
  };
}
