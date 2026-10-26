import { defineOidcApp } from "../../../library/oidc-app";

export const doopIdentity = defineOidcApp("doop", {
  name: "Doop",
  secretKey: "doopOidcClientSecret",
  host: "design.gdario.dev",
  callbackPath: "/api/auth/oauth2/callback/oidc",
  scopes: ["openid", "profile", "email"],
  // Authentik manages local identities; this claim also gates Doop's admin bootstrap.
  verifiedLocalEmail: true,
});
