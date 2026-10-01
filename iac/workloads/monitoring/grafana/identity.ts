import { defineOidcApp } from "../../../library/oidc-app";

export const grafanaIdentity = defineOidcApp("grafana", { name: "Grafana", secretKey: "grafana-secret", host: "grafana.gdario.dev", callbackPath: "/login/generic_oauth" });
