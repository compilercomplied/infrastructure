import { defineOidcApp } from "../../library/oidc-app";

export const linkwardenIdentity = defineOidcApp("linkwarden", { name: "Linkwarden", secretKey: "linkwarden-secret", host: "linkwarden.gdario.dev", callbackPath: "/api/v1/auth/callback/authentik" });
