import { defineOidcApp } from "../../../library/oidc-app";

export const outlineIdentity = defineOidcApp("outline", { name: "Outline Wiki", secretKey: "outlineOidcClientSecret", host: "outline.gdario.dev", callbackPath: "/auth/oidc.callback" });
