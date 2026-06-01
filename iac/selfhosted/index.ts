import * as k8s from "@pulumi/kubernetes";
import { configureSharedPostgres } from "./shared-postgres";
import { configureTandoorRecipes } from "./tandoor-recipes";

export function configureSelfhosted() {
  const namespace = new k8s.core.v1.Namespace("selfhosted", {
    metadata: { name: "selfhosted" }
  });

  const namespaceName = namespace.metadata.name;

	// Deployments
  const postgres = configureSharedPostgres(namespaceName);
  const tandoor = configureTandoorRecipes(namespaceName, [postgres]);

  return {
    namespace: namespaceName,
    postgres,
    tandoor
  };
}
