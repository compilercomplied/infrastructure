import { defineOidcApp } from "../../../library/oidc-app";

export const forgejoIdentity = defineOidcApp("forgejo", { name: "Forgejo", secretKey: "forgejo-secret", host: "git.gdario.dev", callbackPath: "/user/oauth2/Authentik/callback" });
