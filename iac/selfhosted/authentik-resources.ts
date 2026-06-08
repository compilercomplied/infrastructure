import * as authentik from "@pulumi/authentik";
import * as pulumi from "@pulumi/pulumi";
import { createAuthentikOpenId } from "../library/authentik";
import { getAuthorizedUsers, getGroupDefinitions } from "./users";

export function configureAuthentikResources() {
  const selfhostedConfig = new pulumi.Config("selfhosted");
  const tandooriSecret = selfhostedConfig.requireSecret("tandoori-secret");

  // Load the central user directory configuration.
  const users = getAuthorizedUsers();

  // Provision users centrally in Authentik. Existing users in the database will be
  // matched by username/email via the Authentik provider.
  const authentikUsers = users.map(u => new authentik.User(u.name, {
    username: u.name,
    name: u.name,
    email: u.email,
    isActive: true,
  }));

  // Create a mapping of username to their respective Authentik ID Output.
  // Using a reducer map makes resolving members by username simple and DRY.
  const userIdMap = users.reduce((acc, u, i) => {
    acc[u.name] = authentikUsers[i].id.apply(id => parseInt(id));
    return acc;
  }, {} as Record<string, pulumi.Output<number>>);

  // Retrieve central group mappings and dynamically provision the Authentik groups.
  // This loop handles hermes-users, grafana-admins, and any future groups automatically.
  const groupDefs = getGroupDefinitions(users.map(u => u.name));
  const groups = groupDefs.reduce((acc, gd) => {
    const group = new authentik.Group(gd.name, {
      name: gd.name,
      users: pulumi.all(gd.members.map(m => userIdMap[m])),
    });
    acc[gd.name] = group;
    return acc;
  }, {} as Record<string, authentik.Group>);

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
    // We set enrollmentFlow to an empty string to clear any existing registration
    // flow and prevent self-service signup via Google OAuth.
    enrollmentFlow: "",
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
    hermesGroupId: groups["hermes-users"].id,
    grafanaAdminsGroupId: groups["grafana-admins"].id,
  };
}
