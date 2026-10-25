import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";
import { createLetsEncryptIngress } from "../../../library/ingress";
import { oidcClientSecret, oidcIssuer } from "../../../library/oidc-app";
import { createPostgresBootstrap } from "../../../library/postgres-bootstrap";
import { createBackupJob } from "../../../operations/maintenance/backup";
import { Labels } from "../labels";
import { penpotIdentity } from "./identity";

const chartVersion = "1.11.4";
const postgresHost = "shared-postgres.shared-resources.svc.cluster.local";

export function configurePenpot(namespace: pulumi.Input<string>, dependencies: pulumi.Resource[] = []) {
  const name = "penpot";
  const config = new pulumi.Config("selfhosted");
  const databasePassword = config.requireSecret("penpotDbPassword");
  const redisPassword = config.requireSecret("penpotRedisPassword");
  const clientSecret = oidcClientSecret(penpotIdentity, config);

  const settings = new k8s.core.v1.Secret(`${name}-settings`, {
    metadata: { name: `${name}-settings`, namespace },
    stringData: {
      apiSecretKey: config.requireSecret("penpotApiSecretKey"),
      postgresqlUri: pulumi.interpolate`postgresql://${postgresHost}:5432/${name}`,
      postgresqlUsername: name,
      postgresqlPassword: databasePassword,
      redisPassword,
      redisUri: pulumi.interpolate`redis://:${redisPassword}@${name}-valkey:6379/0`,
      oidcClientId: penpotIdentity.clientId,
      oidcClientSecret: clientSecret,
    },
  }, { dependsOn: dependencies });

  const valkey = new k8s.apps.v1.Deployment(`${name}-valkey`, {
    metadata: { name: `${name}-valkey`, namespace },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: `${name}-valkey` } },
      template: {
        metadata: { labels: { app: `${name}-valkey` } },
        spec: {
          containers: [{
            name: "valkey",
            image: "valkey/valkey:8.1.3-alpine",
            args: ["--requirepass", "$(VALKEY_PASSWORD)"],
            ports: [{ name: "valkey", containerPort: 6379 }],
            env: [{ name: "VALKEY_PASSWORD", valueFrom: { secretKeyRef: { name: settings.metadata.name, key: "redisPassword" } } }],
            resources: { requests: { cpu: "25m", memory: "64Mi" }, limits: { cpu: "250m", memory: "128Mi" } },
          }],
        },
      },
    },
  }, { dependsOn: [settings, ...dependencies] });

  const valkeyService = new k8s.core.v1.Service(`${name}-valkey`, {
    metadata: { name: `${name}-valkey`, namespace },
    spec: { selector: { app: `${name}-valkey` }, ports: [{ name: "valkey", port: 6379, targetPort: 6379 }] },
  }, { dependsOn: valkey });

  const dbInit = createPostgresBootstrap({
    name,
    namespace,
    databasePassword,
    adminPassword: config.requireSecret("postgresPassword"),
    scriptPaths: [path.join(__dirname, "scripts", "postgres_bootstrap.sql")],
    dependencies,
  });

  const penpot = new k8s.helm.v3.Chart(name, {
    namespace,
    chart: name,
    version: chartVersion,
    fetchOpts: { repo: "https://helm.penpot.app/" },
    values: {
      fullnameOverride: name,
      config: {
        publicUri: penpotIdentity.url,
        flags: "enable-login-with-oidc enable-oidc-registration disable-login-with-password disable-registration",
        existingSecret: settings.metadata.name,
        secretKeys: { apiSecretKey: "apiSecretKey" },
        postgresql: {
          existingSecret: settings.metadata.name,
          secretKeys: { postgresqlUriKey: "postgresqlUri", usernameKey: "postgresqlUsername", passwordKey: "postgresqlPassword" },
        },
        redis: { existingSecret: settings.metadata.name, secretKeys: { redisUriKey: "redisUri" } },
        providers: {
          oidc: { enabled: true, baseURI: oidcIssuer(penpotIdentity), scopes: penpotIdentity.scopes.join(" ") },
          existingSecret: settings.metadata.name,
          secretKeys: { oidcClientIDKey: "oidcClientId", oidcClientSecretKey: "oidcClientSecret" },
        },
      },
      backend: {
        image: { repository: "penpotapp/backend", tag: "2.18.4", pullPolicy: "IfNotPresent" },
        podLabels: { [Labels.Network.AllowPostgres]: "true", [Labels.Network.AllowAuthentik]: "true" },
        extraEnvs: [{ name: "PENPOT_SSRF_ALLOWED_HOSTS", value: "auth.gdario.dev" }],
        resources: { requests: { cpu: "100m", memory: "512Mi" }, limits: { cpu: "1", memory: "1Gi" } },
      },
      frontend: {
        image: { repository: "penpotapp/frontend", tag: "2.18.4", pullPolicy: "IfNotPresent" },
        resources: { requests: { cpu: "25m", memory: "128Mi" }, limits: { cpu: "250m", memory: "256Mi" } },
      },
      exporter: {
        image: { repository: "penpotapp/exporter", tag: "2.18.4", pullPolicy: "IfNotPresent" },
        resources: { requests: { cpu: "25m", memory: "128Mi" }, limits: { cpu: "250m", memory: "256Mi" } },
      },
      persistence: { assets: { enabled: true, storageClass: "local-path", size: "20Gi" } },
      ingress: { enabled: false },
    },
  }, { dependsOn: [settings, valkeyService, dbInit, ...dependencies] });

  const ingress = createLetsEncryptIngress({
    name,
    namespace,
    host: penpotIdentity.host,
    serviceName: name,
    servicePort: 8080,
    targetPort: 8080,
    podSelector: { "app.kubernetes.io/name": `${name}-frontend`, "app.kubernetes.io/instance": name },
    dependencies: [penpot],
  });

  const backendPolicy = new k8s.networking.v1.NetworkPolicy(`${name}-backend-allow-frontend`, {
    metadata: { name: `${name}-backend-allow-frontend`, namespace },
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/name": `${name}-backend`, "app.kubernetes.io/instance": name } },
      ingress: [{
        from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": `${name}-frontend`, "app.kubernetes.io/instance": name } } }],
        ports: [{ port: 6060 }],
      }],
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: penpot });

  const frontendInternalPolicy = new k8s.networking.v1.NetworkPolicy(`${name}-frontend-allow-exporter`, {
    metadata: { name: `${name}-frontend-allow-exporter`, namespace },
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/name": `${name}-frontend`, "app.kubernetes.io/instance": name } },
      ingress: [{
        from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": `${name}-exporter`, "app.kubernetes.io/instance": name } } }],
        ports: [{ port: 8080 }],
      }],
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: penpot });

  const valkeyPolicy = new k8s.networking.v1.NetworkPolicy(`${name}-valkey-allow-ingress`, {
    metadata: { name: `${name}-valkey-allow-ingress`, namespace },
    spec: {
      podSelector: { matchLabels: { app: `${name}-valkey` } },
      ingress: [{
        from: ["backend", "exporter"].map(component => ({ podSelector: { matchLabels: { "app.kubernetes.io/name": `${name}-${component}`, "app.kubernetes.io/instance": name } } })),
        ports: [{ port: 6379 }],
      }],
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: valkeyService });

  const healthProbe = new k8s.apiextensions.CustomResource(`${name}-health`, {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "Probe",
    metadata: { name: `${name}-health`, namespace, labels: { app: name, "homelab.gdario.dev/health-contract": "v1" } },
    spec: {
      jobName: pulumi.interpolate`health-${namespace}-${name}`,
      interval: "5m",
      scrapeTimeout: "10s",
      module: "http_2xx",
      prober: { url: "blackbox-exporter.monitoring.svc.cluster.local:9115", path: "/probe" },
      targets: { staticConfig: { static: [pulumi.interpolate`http://${name}.${namespace}.svc.cluster.local:8080/`] } },
    },
  }, { dependsOn: [penpot] });

  const databaseBackup = createBackupJob({
    appName: name,
    namespace,
    source: { type: "postgres", databaseName: name, dbHost: postgresHost, dbUser: name, dbPasswordSecret: databasePassword },
    dependencies: [penpot],
  });
  const assetsBackup = createBackupJob({
    appName: name,
    namespace,
    source: { type: "pvc", pvcName: `${name}-data-assets`, mountPath: "/assets" },
    dependencies: [penpot],
  });

  return { penpot, valkey, valkeyService, ingress, backendPolicy, frontendInternalPolicy, valkeyPolicy, healthProbe, dbInit, databaseBackup, assetsBackup };
}
