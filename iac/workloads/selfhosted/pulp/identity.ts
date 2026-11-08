import { defineOidcApp } from "../../../library/oidc-app";

export const pulpIdentity = defineOidcApp("pulp", {
  name: "Pulp",
  secretKey: "pulpOidcClientSecret",
  host: "pulp.gdario.dev",
  callbackPath: "/oauth2/callback",
  verifiedLocalEmail: true,
});
