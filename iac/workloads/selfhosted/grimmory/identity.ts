import { defineOidcApp } from "../../../library/oidc-app";

export const grimmoryIdentity = defineOidcApp("grimmory", { name: "Grimmory", secretKey: "grimmory-secret", host: "grimmory.gdario.dev", callbackPath: "/oauth2-callback" });
