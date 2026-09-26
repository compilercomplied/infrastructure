import * as pulumi from "@pulumi/pulumi";
import { AppConfig, AppSecrets, AppSettings } from "../../library/app-settings";

export class TandoorRecipesSettings implements AppSettings {
  public readonly config: AppConfig = {
    "DB_ENGINE": "django.db.backends.postgresql",
    "POSTGRES_HOST": "shared-postgres.shared-resources.svc.cluster.local",
    "POSTGRES_PORT": "5432",
    "POSTGRES_DB": "tandoor",
    "POSTGRES_USER": "tandoor",
    "ALLOWED_HOSTS": "recipes.gdario.dev,tandoor-recipes,tandoor-recipes.selfhosted.svc.cluster.local",
    "TANDOOR_PORT": "8080",
    "SOCIAL_PROVIDERS": "allauth.socialaccount.providers.openid_connect",
    "HIDE_LOGIN_FORM": "1",
  };
  public readonly secrets: AppSecrets;

  constructor(config = new pulumi.Config("selfhosted")) {
    const oidcClientSecret = config.requireSecret("tandoori-secret");
    this.secrets = {
      "SECRET_KEY": config.requireSecret("tandoorSecretKey"),
      "POSTGRES_PASSWORD": config.requireSecret("tandoorDbPassword"),
      "SOCIALACCOUNT_PROVIDERS": pulumi.interpolate`{
    "openid_connect": {
      "SCOPE": ["openid", "profile", "email", "offline_access"],
      "SERVERS": [
        {
          "id": "authentik",
          "name": "Authentik",
          "server_url": "https://auth.gdario.dev/application/o/tandoor-recipes/.well-known/openid-configuration",
          "token_auth_method": "client_secret_basic",
          "APP": {
            "client_id": "tandoor-recipes-client-id",
            "secret": "${oidcClientSecret}"
          }
        }
      ]
    }
  }`,
    };
  }
}

export const tandoorRecipesSettings = new TandoorRecipesSettings();
