import * as pulumi from "@pulumi/pulumi";
import { createSelfhostedApp } from "../library/selfhosted-app";

export function configureTandoorRecipes(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config("selfhosted");
  const tandoorDbPassword = config.requireSecret("tandoorDbPassword");
  const tandoorSecretKey = config.requireSecret("tandoorSecretKey");
  const tandooriSecret = config.requireSecret("tandoori-secret");

  const socialaccountProviders = pulumi.interpolate`{
    "openid_connect": {
      "SERVERS": [
        {
          "id": "authentik",
          "name": "Authentik",
          "server_url": "https://auth.gdario.dev/application/o/tandoor-recipes/.well-known/openid-configuration",
          "token_auth_method": "client_secret_basic",
          "APP": {
            "client_id": "tandoor-recipes-client-id",
            "secret": "${tandooriSecret}"
          }
        }
      ]
    }
  }`;

  return createSelfhostedApp({
    name: "tandoor-recipes",
    namespace,
    image: "ghcr.io/tandoorrecipes/recipes:2.6.9",
    containerPort: 8080,
    exposeType: "public",
    host: "recipes.gdario.dev",
    secrets: {
      "SECRET_KEY": tandoorSecretKey,
      "POSTGRES_PASSWORD": tandoorDbPassword,
      "SOCIALACCOUNT_PROVIDERS": socialaccountProviders,
    },
    env: [
      { name: "DB_ENGINE", value: "django.db.backends.postgresql" },
      { name: "POSTGRES_HOST", value: "shared-postgres.selfhosted.svc.cluster.local" },
      { name: "POSTGRES_PORT", value: "5432" },
      { name: "POSTGRES_DB", value: "tandoor" },
      { name: "POSTGRES_USER", value: "tandoor" },
      { name: "ALLOWED_HOSTS", value: "*" },
      { name: "TANDOOR_PORT", value: "8080" },
      { name: "SOCIAL_PROVIDERS", value: "allauth.socialaccount.providers.openid_connect" },
      { name: "HIDE_LOGIN_FORM", value: "1" },
    ],
    volumes: [
      {
        name: "tandoor-media",
        mountPath: "/opt/recipes/mediafiles",
        size: "10Gi",
        pvcName: "tandoor-recipes-media-pvc",
      },
    ],
    dependencies,
  });
}

