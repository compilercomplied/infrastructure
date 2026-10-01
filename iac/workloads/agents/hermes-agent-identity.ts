import { defineOidcApp } from "../../library/oidc-app";

export const hermesIdentity = defineOidcApp("hermes", { name: "Hermes Agent", secretKey: "hermesSecret", host: "hermes.gdario.dev", callbackPath: "/auth/callback" });
