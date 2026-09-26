import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp } from "../../library/selfhosted-component";
import { Labels } from "./labels";
import { tandoorRecipesSettings } from "./tandoor-recipes-settings";

export function configureTandoorRecipes(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {

  const app = new SelfhostedApp("tandoor-recipes", {
    namespace,
    image: "ghcr.io/tandoorrecipes/recipes:2.6.9",
    endpoints: [{
      name: "http",
      servicePort: 80,
      containerPort: 8080,
      ingress: { name: "tandoor-recipes", host: "recipes.gdario.dev" },
      healthCheck: { protocol: "http", path: "/api/health" },
      allowIngressFrom: [{
        podSelector: { app: "tandoor-mcp" },
        namespaceSelector: { "kubernetes.io/metadata.name": "agent-sidekicks" },
      }],
    }],
    labels: {
      [Labels.Network.AllowPostgres]: "true",
      [Labels.Network.AllowAuthentik]: "true",
    },
    settings: tandoorRecipesSettings,
    volumes: [
      {
        name: "tandoor-media",
        mountPath: "/opt/recipes/mediafiles",
        size: "10Gi",
        pvcName: "tandoor-recipes-media-pvc",
      },
    ],
    databases: [
      {
        type: "postgres",
        databaseName: "tandoor",
        host: "shared-postgres.shared-resources.svc.cluster.local",
        username: "tandoor",
        passwordSecret: tandoorRecipesSettings.secrets["POSTGRES_PASSWORD"],
      },
    ],

    dependencies,
  });

  return {
    deployment: app.deployment,
  };
}
