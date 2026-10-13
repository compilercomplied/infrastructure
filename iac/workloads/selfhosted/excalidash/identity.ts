import { defineOidcApp } from "../../../library/oidc-app";

export const excalidashIdentity = defineOidcApp("excalidash", {
  name: "ExcaliDash",
  secretKey: "excalidashOidcClientSecret",
  host: "draw.gdario.dev",
  callbackPath: "/api/auth/oidc/callback",
  scopes: ["openid", "profile", "email"],
  verifiedLocalEmail: true,
});
