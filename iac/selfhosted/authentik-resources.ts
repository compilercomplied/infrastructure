import * as authentik from "@pulumi/authentik";
import * as pulumi from "@pulumi/pulumi";

export function configureAuthentikResources() {
  const selfhostedConfig = new pulumi.Config("selfhosted");
  const tandooriSecret = selfhostedConfig.requireSecret("tandoori-secret");

  // 2. Create the OAuth2/OIDC Provider for Tandoor Recipes
  const tandoorProvider = new authentik.ProviderOauth2("tandoor-recipes-provider", {
    name: "Tandoor Recipes SSO",
    // You can set a custom Client ID or let Authentik auto-generate it.
    clientId: "tandoor-recipes-client-id",
    // Generate a high-entropy client secret key (or read from Pulumi config)
    clientSecret: tandooriSecret,
    authorizationFlow: "9faae557-fad6-4f95-876c-545adc95b3e4", // Static default authorization flow UUID
    invalidationFlow: "12830a53-f573-488d-bdc2-f12ddc59c0a7", // Static default invalidation flow UUID
    
    // Redirect URIs that Tandoor will use during the OAuth exchange
    allowedRedirectUris: [
      {
        matching_mode: "strict",
        url: "https://recipes.gdario.dev/accounts/oidc/authentik/login/callback/",
      },
    ],
  });

  // 3. Create the Application mapping which links the Provider to Authentik's portal
  const tandoorApp = new authentik.Application("tandoor-recipes-app", {
    name: "Tandoor Recipes",
    slug: "tandoor-recipes",
    protocolProvider: tandoorProvider.id.apply(id => parseInt(id)),
    
    // Launch configurations for the Authentik User Portal
    metaLaunchUrl: "https://recipes.gdario.dev",
    metaPublisher: "GDario Labs",
  });

  return {
    tandoorProviderId: tandoorProvider.id,
    tandoorAppSlug: tandoorApp.slug,
  };
}
