import * as pulumi from "@pulumi/pulumi";
import { AppConfig, AppSecrets, AppSettings } from "../../library/app-settings";

export class AuthentikSettings implements AppSettings {
  public readonly config: AppConfig = {
    "AUTHENTIK_POSTGRESQL__HOST": "shared-postgres.shared-resources.svc.cluster.local",
    "AUTHENTIK_POSTGRESQL__USER": "authentik",
    "AUTHENTIK_POSTGRESQL__NAME": "authentik",
    "AUTHENTIK_POSTGRESQL__PORT": "5432",
    "AUTHENTIK_ERROR_REPORTING__ENABLED": "false",
  };
  public readonly secrets: AppSecrets;
  public readonly databasePassword: pulumi.Output<string>;

  constructor(config = new pulumi.Config("selfhosted")) {
    this.databasePassword = config.requireSecret("authentikDbPassword");
    this.secrets = {
      "AUTHENTIK_SECRET_KEY": config.requireSecret("authentikSecretKey"),
      "AUTHENTIK_POSTGRESQL__PASSWORD": this.databasePassword,
      "AUTHENTIK_BOOTSTRAP_PASSWORD": config.requireSecret("authentikAdminPassword"),
      "AUTHENTIK_BOOTSTRAP_EMAIL": config.requireSecret("acmeEmail"),
      "AUTHENTIK_REDIS__PASSWORD": config.requireSecret("authentikRedisPassword"),
      "AUTHENTIK_TANDOOR_CLIENT_SECRET": config.requireSecret("tandoori-secret"),
      "AUTHENTIK_LINKWARDEN_CLIENT_SECRET": config.requireSecret("linkwarden-secret"),
      "AUTHENTIK_GRAFANA_CLIENT_SECRET": config.requireSecret("grafana-secret"),
      "AUTHENTIK_GRIMMORY_CLIENT_SECRET": config.requireSecret("grimmory-secret"),
      "AUTHENTIK_HERMES_CLIENT_SECRET": config.requireSecret("hermesSecret"),
      "AUTHENTIK_GOOGLE_CLIENT_ID": config.require("googleClientId"),
      "AUTHENTIK_GOOGLE_CLIENT_SECRET": config.requireSecret("googleClientSecret"),
      "AUTHENTIK_USER_GDARIO_EMAIL": config.requireSecret("user-gdario-email"),
      "AUTHENTIK_USER_ANDREA_EMAIL": config.requireSecret("user-andrea-email"),
      "AUTHENTIK_FORGEJO_CLIENT_SECRET": config.requireSecret("forgejo-secret"),
      "AUTHENTIK_LITELLM_CLIENT_SECRET": config.requireSecret("litellmSecret"),
    };
  }
}

export const authentikSettings = new AuthentikSettings();
