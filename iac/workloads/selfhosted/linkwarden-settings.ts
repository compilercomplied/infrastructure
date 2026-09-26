import * as pulumi from "@pulumi/pulumi";
import { AppConfig, AppSecrets, AppSettings } from "../../library/app-settings";

export class LinkwardenSettings implements AppSettings {
  public readonly config: AppConfig = {
    "NEXTAUTH_URL": "https://linkwarden.gdario.dev/api/v1/auth",
    "NEXT_PUBLIC_AUTHENTIK_ENABLED": "true",
    "AUTHENTIK_CUSTOM_NAME": "authentik",
    "AUTHENTIK_ISSUER": "https://auth.gdario.dev/application/o/linkwarden",
    "AUTHENTIK_CLIENT_ID": "linkwarden-client-id",
    "OIDC_SCOPES": "openid profile email offline_access",
    "NEXT_PUBLIC_DISABLE_REGISTRATION": "true",
    "NEXT_PUBLIC_CREDENTIALS_ENABLED": "false",
  };
  public readonly secrets: AppSecrets;

  constructor(config = new pulumi.Config("selfhosted")) {
    const databasePassword = config.requireSecret("linkwardenDbPassword");
    this.secrets = {
      "NEXTAUTH_SECRET": config.requireSecret("linkwardenNextAuthSecret"),
      "POSTGRES_PASSWORD": databasePassword,
      "AUTHENTIK_CLIENT_SECRET": config.requireSecret("linkwarden-secret"),
      "DATABASE_URL": pulumi.interpolate`postgresql://linkwarden:${databasePassword}@shared-postgres.shared-resources.svc.cluster.local:5432/linkwarden`,
    };
  }
}

export const linkwardenSettings = new LinkwardenSettings();
