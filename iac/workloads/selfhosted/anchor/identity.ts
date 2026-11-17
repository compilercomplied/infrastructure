import { defineOidcApp } from "../../../library/oidc-app";

export const anchorIdentity = defineOidcApp("anchor", {
  name: "Anchor",
  host: "anchor.gdario.dev",
  callbackPath: "/api/auth/oidc/callback",
  secretKey: "anchorOidcClientSecret",
  generateSecret: true,
  scopes: ["openid", "profile", "email"],
});
