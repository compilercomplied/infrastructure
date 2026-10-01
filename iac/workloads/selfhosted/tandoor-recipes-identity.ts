import { defineOidcApp } from "../../library/oidc-app";

export const tandoorIdentity = defineOidcApp("tandoor", { name: "Tandoor Recipes", slug: "tandoor-recipes", secretKey: "tandoori-secret", host: "recipes.gdario.dev", callbackPath: "/accounts/oidc/authentik/login/callback/" });
