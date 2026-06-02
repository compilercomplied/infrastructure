import * as authentik from "@pulumi/authentik";
import * as pulumi from "@pulumi/pulumi";

export function configureAuthentikResources() {
  const selfhostedConfig = new pulumi.Config("selfhosted");
  const tandooriSecret = selfhostedConfig.requireSecret("tandoori-secret");

  const scopeOpenid = authentik.getPropertyMappingProviderScopeOutput({
    managed: "goauthentik.io/providers/oauth2/scope-openid",
  });
  const scopeProfile = authentik.getPropertyMappingProviderScopeOutput({
    managed: "goauthentik.io/providers/oauth2/scope-profile",
  });
  const scopeEmail = authentik.getPropertyMappingProviderScopeOutput({
    managed: "goauthentik.io/providers/oauth2/scope-email",
  });

  const tandoorProvider = new authentik.ProviderOauth2("tandoor-recipes-provider", {
    name: "Tandoor Recipes SSO",
    clientId: "tandoor-recipes-client-id",
    clientSecret: tandooriSecret,
		// This is a manual hack that should have been automated through the
		// authentik pulumi provider.
    authorizationFlow: "9faae557-fad6-4f95-876c-545adc95b3e4",
    invalidationFlow: "12830a53-f573-488d-bdc2-f12ddc59c0a7",
    
    allowedRedirectUris: [
      {
        matching_mode: "strict",
        url: "https://recipes.gdario.dev/accounts/oidc/authentik/login/callback/",
      },
    ],
    propertyMappings: [
      scopeOpenid.id,
      scopeProfile.id,
      scopeEmail.id,
    ],
  });

  const tandoorApp = new authentik.Application("tandoor-recipes-app", {
    name: "Tandoor Recipes",
    slug: "tandoor-recipes",
    protocolProvider: tandoorProvider.id.apply(id => parseInt(id)),
    
    metaLaunchUrl: "https://recipes.gdario.dev",
    metaPublisher: "GDario Labs",
  });

  const googleClientId = selfhostedConfig.require("googleClientId");
  const googleClientSecret = selfhostedConfig.requireSecret("googleClientSecret");

  const googleSource = new authentik.SourceOauth("google-source", {
    name: "Google",
    slug: "google",
    providerType: "google",
    consumerKey: googleClientId,
    consumerSecret: googleClientSecret,
		// This is a manual hack that should have been automated through the
		// authentik pulumi provider.
    authenticationFlow: "a7c56c41-379d-417c-9885-f0d55e174317",
    enrollmentFlow: "96f96a88-5eec-46fd-9943-ba706bfdc8be",
    userMatchingMode: "email_link",
  });

  return {
    tandoorProviderId: tandoorProvider.id,
    tandoorAppSlug: tandoorApp.slug,
    googleSourceId: googleSource.id,
  };
}
