import * as pulumi from "@pulumi/pulumi";

export const keycloakIssuer = "https://keycloak.gdario.dev/realms/homelab";
export const keycloakDiscoveryUrl = `${keycloakIssuer}/.well-known/openid-configuration`;
export const keycloakAuthorizeUrl = `${keycloakIssuer}/protocol/openid-connect/auth`;
export const keycloakTokenUrl = `${keycloakIssuer}/protocol/openid-connect/token`;
export const keycloakUserInfoUrl = `${keycloakIssuer}/protocol/openid-connect/userinfo`;

export type OidcScope = "openid" | "profile" | "email" | "offline_access";

export interface OidcAppDefinition {
  name: string;
  host: string;
  callbackPath: string;
  secretKey: string;
  slug?: string;
  scopes?: readonly OidcScope[];
}

export interface OidcAppRegistration extends OidcAppDefinition {
  key: string;
  slug: string;
  url: string;
  clientId: string;
  scopes: readonly OidcScope[];
}

const standardScopes: readonly OidcScope[] = ["openid", "profile", "email", "offline_access"];

export function defineOidcApp(key: string, definition: OidcAppDefinition): OidcAppRegistration {
  const slug = definition.slug ?? key;
  return {
    ...definition,
    key,
    slug,
    url: `https://${definition.host}`,
    clientId: `${slug}-client-id`,
    scopes: definition.scopes ?? standardScopes,
  };
}

export function oidcClientSecret(app: OidcAppRegistration, config = new pulumi.Config("selfhosted")): pulumi.Output<string> {
  return config.requireSecret(app.secretKey);
}
