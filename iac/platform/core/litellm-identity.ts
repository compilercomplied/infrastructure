import { defineOidcApp } from "../../library/oidc-app";

export const litellmIdentity = defineOidcApp("litellm", { name: "LiteLLM", secretKey: "litellmSecret", host: "litellm.gdario.dev", callbackPath: "/sso/callback" });
