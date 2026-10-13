import * as pulumi from "@pulumi/pulumi";
import { AppConfig, AppSecrets, AppSettings } from "../../../library/app-settings";
import { excalidashIdentity } from "./identity";
import { oidcClientSecret, oidcIssuer } from "../../../library/oidc-app";

export class ExcaliDashSettings implements AppSettings {
  public readonly config: AppConfig;
  public readonly secrets: AppSecrets;
  public readonly databasePassword: pulumi.Output<string>;

  constructor(config = new pulumi.Config("selfhosted")) {
    this.databasePassword = config.requireSecret("excalidashDbPassword");
    this.config = {
      "DATABASE_PROVIDER": "postgresql",
      "FRONTEND_URL": excalidashIdentity.url,
      "TRUST_PROXY": "1",
      "AUTH_MODE": "oidc_enforced",
      "OIDC_PROVIDER_NAME": "Authentik",
      "OIDC_ISSUER_URL": oidcIssuer(excalidashIdentity),
      "OIDC_CLIENT_ID": excalidashIdentity.clientId,
      "OIDC_REDIRECT_URI": `${excalidashIdentity.url}${excalidashIdentity.callbackPath}`,
      "OIDC_SCOPES": excalidashIdentity.scopes.join(" "),
      "OIDC_ADMIN_GROUPS": "excalidash-admins",
      "OIDC_REQUIRE_EMAIL_VERIFIED": "true",
      "OIDC_JIT_PROVISIONING": "true",
      "OIDC_FIRST_USER_ADMIN": "false",
      "RUN_MIGRATIONS": "true",
    };
    this.secrets = {
      "DATABASE_URL": pulumi.interpolate`postgresql://excalidash:${this.databasePassword}@shared-postgres.shared-resources.svc.cluster.local:5432/excalidash`,
      "JWT_SECRET": config.requireSecret("excalidashJwtSecret"),
      "CSRF_SECRET": config.requireSecret("excalidashCsrfSecret"),
      "API_KEY_HASH_PEPPER": config.requireSecret("excalidashApiKeyHashPepper"),
      "OIDC_CLIENT_SECRET": oidcClientSecret(excalidashIdentity, config),
    };
  }
}

export const excalidashSettings = new ExcaliDashSettings();
