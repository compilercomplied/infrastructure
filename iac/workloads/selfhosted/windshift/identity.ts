import { defineOidcApp } from "../../../library/oidc-app";

export const windshiftIdentity = defineOidcApp("windshift", { name: "Windshift", secretKey: "windshiftOidcClientSecret", host: "projects.gdario.dev", callbackPath: "/api/sso/callback/keycloak", scopes: ["openid", "profile", "email"], });
