import * as authentik from "@pulumi/authentik";
import * as pulumi from "@pulumi/pulumi";

let cachedScopes: { openid: pulumi.Output<string>; profile: pulumi.Output<string>; email: pulumi.Output<string> } | null = null;

// Retrieves and caches scope IDs from Authentik. Since scope properties are managed
// by the system and static, caching avoids querying the API multiple times.
function getScopes(): { openid: pulumi.Output<string>; profile: pulumi.Output<string>; email: pulumi.Output<string> } {
  if (!cachedScopes) {
    const scopeOpenid = authentik.getPropertyMappingProviderScopeOutput({
      managed: "goauthentik.io/providers/oauth2/scope-openid",
    });
    const scopeProfile = authentik.getPropertyMappingProviderScopeOutput({
      managed: "goauthentik.io/providers/oauth2/scope-profile",
    });
    const scopeEmail = authentik.getPropertyMappingProviderScopeOutput({
      managed: "goauthentik.io/providers/oauth2/scope-email",
    });
    cachedScopes = {
      openid: scopeOpenid.id,
      profile: scopeProfile.id,
      email: scopeEmail.id,
    };
  }
  return cachedScopes;
}

export interface AuthentikOpenIdArgs {
  name: string;
  slug: string;
  clientId: string;
  clientSecret: pulumi.Input<string>;
  redirectUris: string[];
  launchUrl: string;
  clientType?: string;
  /** Optional parent resource to establish the Pulumi resource hierarchy. */
  parent?: pulumi.Resource;
  /** Optional aliases to preserve resource URNs when migrating resources under component resources. */
  aliases?: pulumi.Alias[];
}

// Configures a standardized OAuth2/OpenID Connect provider and application in Authentik.
// Using this helper enforces consistency across all self-hosted applications.
export function createAuthentikOpenId(args: AuthentikOpenIdArgs) {
  const scopes = getScopes();
  const { parent, aliases } = args;

  const provider = new authentik.ProviderOauth2(`${args.slug}-provider`, {
    name: `${args.name} SSO`,
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    clientType: args.clientType || "confidential",
    // These flow and key UUIDs reference pre-existing configurations in the Authentik
    // database. Because these default configurations are not managed by this Pulumi
    // lifecycle, they are referenced here as hardcoded IDs.
    authorizationFlow: "9faae557-fad6-4f95-876c-545adc95b3e4",
    invalidationFlow: "12830a53-f573-488d-bdc2-f12ddc59c0a7",
    signingKey: "e96bc021-31ba-451e-b3ae-a7c62b7f1363",
    allowedRedirectUris: args.redirectUris.map(url => ({
      matching_mode: "strict",
      url,
    })),
    propertyMappings: [
      scopes.openid,
      scopes.profile,
      scopes.email,
    ],
  }, { parent, aliases });

  const app = new authentik.Application(`${args.slug}-app`, {
    name: args.name,
    slug: args.slug,
    protocolProvider: provider.id.apply(id => parseInt(id)),
    metaLaunchUrl: args.launchUrl,
    metaPublisher: "GDario Labs",
  }, { parent, aliases });

  return { provider, app };
}
