import * as pulumi from "@pulumi/pulumi";

export const authentikBaseUrl = "https://auth.gdario.dev";
export const authentikAuthorizeUrl = `${authentikBaseUrl}/application/o/authorize/`;
export const authentikTokenUrl = `${authentikBaseUrl}/application/o/token/`;
export const authentikUserInfoUrl = `${authentikBaseUrl}/application/o/userinfo/`;

export type OidcScope = "openid" | "profile" | "email" | "offline_access";

export interface OidcAppDefinition {
  name: string;
  host: string;
  callbackPath: string;
  secretKey: string;
  slug?: string;
  scopes?: readonly OidcScope[];
  providerName?: string;
  verifiedLocalEmail?: boolean;
}

export interface OidcAppRegistration extends OidcAppDefinition {
  key: string;
  slug: string;
  url: string;
  clientId: string;
  secretEnv: string;
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
    secretEnv: `AUTHENTIK_${key.toUpperCase()}_CLIENT_SECRET`,
    scopes: definition.scopes ?? standardScopes,
  };
}

export function oidcIssuer(app: OidcAppRegistration): string {
  return `${authentikBaseUrl}/application/o/${app.slug}/`;
}

export function oidcDiscoveryUrl(app: OidcAppRegistration): string {
  return `${oidcIssuer(app)}.well-known/openid-configuration`;
}

export function oidcClientSecret(app: OidcAppRegistration, config = new pulumi.Config("selfhosted")): pulumi.Output<string> {
  return config.requireSecret(app.secretKey);
}
