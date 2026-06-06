import * as authentik from "@pulumi/authentik";
import * as pulumi from "@pulumi/pulumi";
import { createAuthentikOpenId } from "../library/authentik";

export function configureAuthentikResources() {
  const selfhostedConfig = new pulumi.Config("selfhosted");
  const tandooriSecret = selfhostedConfig.requireSecret("tandoori-secret");

  const tandoor = createAuthentikOpenId({
    name: "Tandoor Recipes",
    slug: "tandoor-recipes",
    clientId: "tandoor-recipes-client-id",
    clientSecret: tandooriSecret,
    redirectUris: [
      "https://recipes.gdario.dev/accounts/oidc/authentik/login/callback/",
    ],
    launchUrl: "https://recipes.gdario.dev",
  });

  const googleClientId = selfhostedConfig.require("googleClientId");
  const googleClientSecret = selfhostedConfig.requireSecret("googleClientSecret");

  const googleSource = new authentik.SourceOauth("google-source", {
    name: "Google",
    slug: "google",
    providerType: "google",
    consumerKey: googleClientId,
    consumerSecret: googleClientSecret,
    // Provide URLs explicitly to prevent Pulumi diffs on every run
    accessTokenUrl: "https://oauth2.googleapis.com/token",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oidcJwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    profileUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    // This is a manual hack that should have been automated through the
    // authentik pulumi provider.
    authenticationFlow: "a7c56c41-379d-417c-9885-f0d55e174317",
    enrollmentFlow: "96f96a88-5eec-46fd-9943-ba706bfdc8be",
    userMatchingMode: "email_link",
  });

  const linkwardenSecret = selfhostedConfig.requireSecret("linkwarden-secret");

  const linkwarden = createAuthentikOpenId({
    name: "Linkwarden",
    slug: "linkwarden",
    clientId: "linkwarden-client-id",
    clientSecret: linkwardenSecret,
    redirectUris: [
      "https://linkwarden.gdario.dev/api/v1/auth/callback/authentik",
    ],
    launchUrl: "https://linkwarden.gdario.dev",
  });

  return {
    tandoorProviderId: tandoor.provider.id,
    tandoorAppSlug: tandoor.app.slug,
    googleSourceId: googleSource.id,
    linkwardenProviderId: linkwarden.provider.id,
    linkwardenAppSlug: linkwarden.app.slug,
  };
}
