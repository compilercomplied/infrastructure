import { defineOidcApp } from "../../../library/oidc-app";

export const anchorIdentity = defineOidcApp("anchor", {
  name: "Anchor",
  host: "notes.gdario.dev",
  callbackPath: "/api/auth/oidc/callback",
  // The phone app shares the server's client ID and exchanges codes without a secret.
  publicClient: true,
  nativeRedirectUris: ["anchor://oidc/callback"],
  scopes: ["openid", "profile", "email"],
});
