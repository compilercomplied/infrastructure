import { linkwardenIdentity } from "./identity";
import * as pulumi from "@pulumi/pulumi";
import { AppConfig, AppSecrets, AppSettings } from "../../../library/app-settings";
import { oidcClientSecret, keycloakIssuer } from "../../../library/oidc-app";

export class LinkwardenSettings implements AppSettings {
  public readonly config: AppConfig = {
    "NEXTAUTH_URL": `${linkwardenIdentity.url}/api/v1/auth`,
    "NEXT_PUBLIC_KEYCLOAK_ENABLED": "true",
    "KEYCLOAK_CUSTOM_NAME": "Keycloak",
    "KEYCLOAK_ISSUER": keycloakIssuer,
    "KEYCLOAK_CLIENT_ID": linkwardenIdentity.clientId,
    "OIDC_SCOPES": linkwardenIdentity.scopes.join(" "),
    "NEXT_PUBLIC_DISABLE_REGISTRATION": "true",
    "NEXT_PUBLIC_CREDENTIALS_ENABLED": "false",
  };
  public readonly secrets: AppSecrets;

  constructor(config = new pulumi.Config("selfhosted")) {
    const databasePassword = config.requireSecret("linkwardenDbPassword");
    this.secrets = {
      "NEXTAUTH_SECRET": config.requireSecret("linkwardenNextAuthSecret"),
      "POSTGRES_PASSWORD": databasePassword,
      "KEYCLOAK_CLIENT_SECRET": oidcClientSecret(linkwardenIdentity, config),
      "DATABASE_URL": pulumi.interpolate`postgresql://linkwarden:${databasePassword}@shared-postgres.shared-resources.svc.cluster.local:5432/linkwarden`,
    };
  }
}

export const linkwardenSettings = new LinkwardenSettings();
