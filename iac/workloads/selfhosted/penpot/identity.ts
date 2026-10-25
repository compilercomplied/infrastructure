import { defineOidcApp } from "../../../library/oidc-app";

export const penpotIdentity = defineOidcApp("penpot", {
  name: "Penpot",
  secretKey: "penpotOidcClientSecret",
  host: "design.gdario.dev",
  callbackPath: "/api/auth/oidc/callback",
  // Local Authentik identities are trusted so SSO registration needs no separate email delivery.
  verifiedLocalEmail: true,
});
