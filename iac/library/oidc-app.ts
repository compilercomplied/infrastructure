import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

export const keycloakBaseUrl = "https://auth.gdario.dev";
export const keycloakIssuer = `${keycloakBaseUrl}/realms/homelab`;
export const keycloakDiscoveryUrl = `${keycloakIssuer}/.well-known/openid-configuration`;
export const keycloakAuthorizeUrl = `${keycloakIssuer}/protocol/openid-connect/auth`;
export const keycloakTokenUrl = `${keycloakIssuer}/protocol/openid-connect/token`;
export const keycloakUserInfoUrl = `${keycloakIssuer}/protocol/openid-connect/userinfo`;

export type OidcScope = "openid" | "profile" | "email" | "offline_access";

export interface OidcAppDefinition {
  name: string;
  host: string;
  callbackPath: string;
  postLogoutRedirectPath?: string;
  secretKey: string;
  generateSecret?: boolean;
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

const generatedSecrets = new Map<string, pulumi.Output<string>>();

export function oidcClientSecret(app: OidcAppRegistration, config = new pulumi.Config("selfhosted")): pulumi.Output<string> {
  if (!app.generateSecret) {
    return config.requireSecret(app.secretKey);
  }
  // The app and Keycloak must share one stable credential from Pulumi state.
  if (!generatedSecrets.has(app.key)) {
    generatedSecrets.set(app.key, pulumi.secret(new random.RandomPassword(`oidc-${app.key}-secret`, {
      length: 48, special: false,
    }).result));
  }
  return generatedSecrets.get(app.key)!;
}
