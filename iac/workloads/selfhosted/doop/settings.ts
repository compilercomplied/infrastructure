import * as pulumi from "@pulumi/pulumi";
import { AppConfig, AppSecrets, AppSettings } from "../../../library/app-settings";
import { oidcClientSecret, oidcIssuer } from "../../../library/oidc-app";
import { doopIdentity } from "./identity";

export class DoopSettings implements AppSettings {
  public readonly config: AppConfig;
  public readonly secrets: AppSecrets;
  public readonly databasePassword: pulumi.Output<string>;

  constructor(config = new pulumi.Config("selfhosted")) {
    this.databasePassword = config.requireSecret("doopDbPassword");
    this.config = {
      NODE_ENV: "production",
      PORT: "4400",
      BETTER_AUTH_URL: doopIdentity.url,
      OIDC_ISSUER: oidcIssuer(doopIdentity),
      OIDC_CLIENT_ID: doopIdentity.clientId,
      OIDC_SCOPES: doopIdentity.scopes.join(" "),
      OIDC_PROVIDER_NAME: "Authentik",
      RESIDENT_TASK_LIMIT: "0",
    };
    this.secrets = {
      DATABASE_URL: this.databasePassword.apply(password => `postgresql://doop:${encodeURIComponent(password)}@shared-postgres.shared-resources.svc.cluster.local:5432/doop`),
      BETTER_AUTH_SECRET: config.requireSecret("doopAuthSecret"),
      OIDC_CLIENT_SECRET: oidcClientSecret(doopIdentity, config),
      ADMIN_EMAILS: config.requireSecret("user-gdario-email"),
    };
  }
}
