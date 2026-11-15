import { defineOidcApp } from "../../../library/oidc-app";

export const doopIdentity = defineOidcApp("doop", {
  name: "Doop",
  secretKey: "doopOidcClientSecret",
  host: "design.gdario.dev",
  callbackPath: "/api/auth/oauth2/callback/oidc",
  scopes: ["openid", "profile", "email"],
  // Verified email gates the application's administrator bootstrap.
});
