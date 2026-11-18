import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { SelfhostedApp } from "../../../library/selfhosted-component";
import { createPostgresBootstrap } from "../../../library/postgres-bootstrap";
import { keycloakIssuer } from "../../../library/oidc-app";
import { Labels } from "../labels";
import { anchorIdentity } from "./identity";

export function configureAnchor(namespace: pulumi.Input<string>, dependencies: pulumi.Resource[] = []) {
  const name = "anchor";
  // The entrypoint interpolates PG_PASSWORD into a URL without escaping it.
  const databasePassword = pulumi.secret(new random.RandomPassword("anchor-db-password", {
    length: 48, special: false,
  }).result);
  const jwtSecret = pulumi.secret(new random.RandomPassword("anchor-jwt-secret", {
    length: 64, special: false,
  }).result);
  const dbInit = createPostgresBootstrap({
    name, namespace, databasePassword,
    adminPassword: new pulumi.Config("selfhosted").requireSecret("postgresPassword"),
    scriptPaths: [path.join(__dirname, "../excalidash/scripts/postgres_bootstrap.sql")],
    automountServiceAccountToken: false,
    dependencies,
  });
  const app = new SelfhostedApp(name, {
    namespace,
    image: "ghcr.io/zhfahim/anchor:0.18.1",
    // Upstream binds the web server to 0.0.0.0, so IPv6 endpoints cannot serve traffic.
    ipFamilyPolicy: "SingleStack",
    ipFamilies: ["IPv4"],
    // Local uploads and startup migrations require a single writer during updates.
    strategy: { type: "Recreate" },
    // Upstream supervisord explicitly switches to root even with external Postgres.
    containerSecurityContext: { capabilities: { add: ["SETUID", "SETGID"] } },
    settings: {
      config: {
        APP_URL: anchorIdentity.url,
        DATA_DIR: "/data",
        CORS_ORIGINS: anchorIdentity.url,
        PG_HOST: "shared-postgres.shared-resources.svc.cluster.local",
        PG_PORT: "5432",
        PG_DATABASE: name,
        PG_USER: name,
        USER_SIGNUP: "disabled",
        OIDC_ENABLED: "true",
        OIDC_PROVIDER_NAME: "Keycloak",
        OIDC_ISSUER_URL: keycloakIssuer,
        OIDC_CLIENT_ID: anchorIdentity.clientId,
        DISABLE_INTERNAL_AUTH: "true",
      },
      secrets: {
        PG_PASSWORD: databasePassword,
        JWT_SECRET: jwtSecret,
      },
    },
    labels: { [Labels.Network.AllowPostgres]: "true" },
    endpoints: [{
      name: "http", servicePort: 80, containerPort: 3000,
      ingress: { host: anchorIdentity.host },
      healthCheck: { protocol: "http", path: "/api/health" },
    }],
    volumes: [{ name: "data", mountPath: "/data", size: "5Gi" }],
    databases: [{
      type: "postgres", databaseName: name, username: name,
      host: "shared-postgres.shared-resources.svc.cluster.local",
      passwordSecret: databasePassword,
    }],
    readinessProbe: {
      httpGet: { path: "/api/health", port: 3000 },
      initialDelaySeconds: 10, periodSeconds: 10,
    },
    livenessProbe: {
      httpGet: { path: "/api/health", port: 3000 },
      initialDelaySeconds: 90, periodSeconds: 30,
    },
    resources: {
      requests: { cpu: "100m", memory: "256Mi" },
      limits: { cpu: "1", memory: "1Gi" },
    },
    dependencies: [...dependencies, dbInit],
  });
  return { deployment: app.deployment };
}
