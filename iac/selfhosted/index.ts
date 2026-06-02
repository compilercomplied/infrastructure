import * as k8s from "@pulumi/kubernetes";
import { configureSharedPostgres } from "./shared-postgres";
import { configureTandoorRecipes } from "./tandoor-recipes";
import { configureAuthentik } from "./authentik";
import { configureAuthentikResources } from "./authentik-resources";
import { configureLinkwarden } from "./linkwarden";

export function configureSelfhosted() {
  const namespace = new k8s.core.v1.Namespace("selfhosted", {
    metadata: { name: "selfhosted" }
  });

  const namespaceName = namespace.metadata.name;

	// Deployments
  const postgres = configureSharedPostgres(namespaceName);
  const tandoor = configureTandoorRecipes(namespaceName, [postgres]);
  const authentik = configureAuthentik(namespaceName, [postgres]);
  const linkwarden = configureLinkwarden(namespaceName, [postgres]);

  // Declarative SSO Applications & Providers configuration
  const authentikResources = configureAuthentikResources();

  return {
    namespace: namespaceName,
    postgres,
    tandoor,
    authentik,
    linkwarden,
    authentikResources
  };
}
