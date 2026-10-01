import { defineOidcApp } from "../../library/oidc-app";

export const memosIdentity = defineOidcApp("memos", { name: "Memos", secretKey: "memosOidcClientSecret", host: "notes.gdario.dev", callbackPath: "/auth/callback" });
