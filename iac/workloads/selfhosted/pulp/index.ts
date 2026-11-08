import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp } from "../../../library/selfhosted-component";
import { createPostgresBootstrap } from "../../../library/postgres-bootstrap";
import { oidcClientSecret, oidcIssuer } from "../../../library/oidc-app";
import { Labels } from "../labels";
import { pulpIdentity } from "./identity";

const image = "pulp/pulp:3.90";
const ciCertificateName = "pulp-ci-tls";

export function configurePulp(namespace: pulumi.Input<string>, dependencies: pulumi.Resource[] = []) {
  const config = new pulumi.Config("selfhosted");
  const databasePassword = config.requireSecret("pulpDbPassword");
  const files = {
    "settings.py": fs.readFileSync(path.join(__dirname, "settings.py"), "utf8"),
    "nginx.conf": fs.readFileSync(path.join(__dirname, "nginx.conf"), "utf8"),
    "bootstrap.py": fs.readFileSync(path.join(__dirname, "scripts", "bootstrap.py"), "utf8"),
  };
  const runtimeChecksum = crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
  // A new name lets Pulumi create the config before rolling out the Deployment.
  const runtime = new k8s.core.v1.ConfigMap("pulp-runtime", {
    metadata: { name: `pulp-runtime-${runtimeChecksum.slice(0, 16)}`, namespace }, data: files,
  }, { dependsOn: dependencies });
  const key = config.requireSecret("pulpDbEncryptionKey");
  const encryptionKey = new k8s.core.v1.Secret("pulp-encryption-key", {
    metadata: { name: "pulp-encryption-key", namespace },
    stringData: { "database_fields.symmetric.key": key },
  }, { dependsOn: dependencies });
  const ciCertificate = new k8s.apiextensions.CustomResource(ciCertificateName, {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: {
      name: ciCertificateName,
      namespace,
      // Pulp's Recreate deployment should keep serving until the first certificate is ready.
      annotations: { "pulumi.com/waitFor": "condition=Ready" },
    },
    spec: {
      secretName: ciCertificateName,
      dnsNames: ["pulp-ci.gdario.dev"],
      issuerRef: { kind: "ClusterIssuer", name: "letsencrypt-prod" },
    },
  }, { dependsOn: dependencies });
  const settings = {
    config: { PULP_SETTINGS: "/etc/pulp/runtime/settings.py" },
    secrets: {
      PULP_DB_PASSWORD: databasePassword,
      PULP_SECRET_KEY: config.requireSecret("pulpSecretKey"),
      PULP_ADMIN_EMAIL: config.requireSecret("user-gdario-email"),
    },
  };
  const dbInit = createPostgresBootstrap({
    name: "pulp", namespace, databasePassword,
    adminPassword: config.requireSecret("postgresPassword"),
    scriptPaths: [path.join(__dirname, "scripts", "postgres_bootstrap.sql")], dependencies,
  });
  const mounts = [
    { name: "data", mountPath: "/var/lib/pulp" },
    { name: "runtime", mountPath: "/etc/pulp/runtime", readOnly: true },
    { name: "encryption-key", mountPath: "/etc/pulp/secrets", readOnly: true },
  ];
  const env = Object.keys({ ...settings.config, ...settings.secrets }).map(name => ({
    name,
    ...(name === "PULP_SETTINGS" ? { value: settings.config.PULP_SETTINGS } : {
      valueFrom: { secretKeyRef: { name: "pulp-secrets", key: name } },
    }),
  }));
  const resources = { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "1", memory: "768Mi" } };
  const app = new SelfhostedApp("pulp", {
    namespace, image,
    command: ["nginx", "-e", "/dev/stderr", "-c", "/etc/pulp/runtime/nginx.conf", "-g", "daemon off;"],
    endpoints: [
      {
        name: "http", servicePort: 80, containerPort: 8080,
        ingress: { name: "pulp", host: pulpIdentity.host, rateLimit: false },
        healthCheck: { protocol: "http", path: "/healthz" },
      },
      {
        name: "android-maven", containerPort: 8081,
        allowIngressFrom: [{
          namespaceSelector: { "kubernetes.io/metadata.name": "forgejo" },
          podSelector: { app: "forgejo-android-runner" },
        }],
      },
    ],
    ipFamilyPolicy: "SingleStack", ipFamilies: ["IPv4"],
    labels: { [Labels.Network.AllowPostgres]: "true", [Labels.Network.AllowAuthentik]: "true" },
    settings,
    volumes: [{ name: "data", mountPath: "/var/lib/pulp", size: "30Gi" }],
    databases: [{ type: "postgres", databaseName: "pulp", username: "pulp", host: "shared-postgres.shared-resources.svc.cluster.local", passwordSecret: databasePassword }],
    additionalVolumes: [
      { name: "runtime", configMap: { name: runtime.metadata.name } },
      { name: "encryption-key", secret: { secretName: encryptionKey.metadata.name } },
      { name: "ci-tls", secret: { secretName: ciCertificateName, defaultMode: 0o440 } },
    ],
    additionalVolumeMounts: [
      ...mounts.filter(mount => mount.name !== "data"),
      { name: "ci-tls", mountPath: "/etc/pulp/ci-tls", readOnly: true },
    ],
    podSecurityContext: { runAsUser: 700, runAsGroup: 700, fsGroup: 700, fsGroupChangePolicy: "OnRootMismatch" },
    automountServiceAccountToken: false,
    strategy: { type: "Recreate" },
    podAnnotations: {
      "homelab.gdario.dev/encryption-key-checksum": key.apply(value => crypto.createHash("sha256").update(value).digest("hex")),
    },
    initContainers: [{
      name: "migrate", image, env, volumeMounts: mounts,
      command: ["/bin/sh", "-ec", "mkdir -p /var/lib/pulp/media /var/lib/pulp/tmp; pulpcore-manager migrate --noinput; pulpcore-manager shell < /etc/pulp/runtime/bootstrap.py"],
      resources,
    }],
    additionalContainers: [
      {
        name: "api", image, env, volumeMounts: mounts, resources,
        command: ["pulpcore-api", "--bind", "127.0.0.1:24817", "--workers", "1", "--timeout", "90"],
        readinessProbe: { exec: { command: ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:24817/pulp/api/v3/status/', timeout=3)"] }, periodSeconds: 10, failureThreshold: 6 },
      },
      {
        name: "content", image, env, volumeMounts: mounts, resources,
        command: ["pulpcore-content", "--bind", "127.0.0.1:24816", "--workers", "1"],
        readinessProbe: { exec: { command: ["python", "-c", "import socket; socket.create_connection(('127.0.0.1', 24816), timeout=3).close()"] }, periodSeconds: 10 },
      },
      {
        name: "worker", image, env, volumeMounts: mounts, resources,
        command: ["pulpcore-worker"],
        readinessProbe: { exec: { command: ["/bin/sh", "-ec", "kill -0 1"] }, periodSeconds: 10 },
      },
      {
        name: "sessions", image: "redis:7.4.7",
        command: ["redis-server", "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--maxmemory", "64mb", "--maxmemory-policy", "allkeys-lru"],
        readinessProbe: { exec: { command: ["redis-cli", "ping"] }, periodSeconds: 10 },
        resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { cpu: "250m", memory: "128Mi" } },
      },
      {
        name: "oidc", image: "quay.io/oauth2-proxy/oauth2-proxy:v7.15.1",
        args: [
          "--http-address=127.0.0.1:4180", "--provider=oidc",
          `--oidc-issuer-url=${oidcIssuer(pulpIdentity)}`, `--client-id=${pulpIdentity.clientId}`,
          `--redirect-url=${pulpIdentity.url}${pulpIdentity.callbackPath}`,
          `--scope=${pulpIdentity.scopes.join(" ")}`, "--email-domain=*",
          "--oidc-email-claim=email", "--set-xauthrequest=true", "--reverse-proxy=true",
          "--upstream=static://202", "--skip-provider-button=true",
          "--cookie-name=__Host-pulp", "--cookie-secure=true", "--cookie-samesite=lax",
          "--session-store-type=redis", "--redis-connection-url=redis://127.0.0.1:6379/0",
          "--cookie-refresh=1h", "--cookie-expire=168h", "--code-challenge-method=S256",
        ],
        env: [
          { name: "OAUTH2_PROXY_CLIENT_SECRET", value: oidcClientSecret(pulpIdentity, config) },
          { name: "OAUTH2_PROXY_COOKIE_SECRET", value: config.requireSecret("pulpSecretKey").apply(value => crypto.createHash("sha256").update(`pulp-cookie:${value}`).digest("base64url")) },
        ],
        resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { cpu: "250m", memory: "128Mi" } },
      },
    ],
    readinessProbe: { httpGet: { path: "/healthz", port: 8080 }, periodSeconds: 10 },
    livenessProbe: { httpGet: { path: "/nginx-healthz", port: 8080 }, periodSeconds: 30 },
    resources: { requests: { cpu: "25m", memory: "64Mi" }, limits: { cpu: "500m", memory: "128Mi" } },
    dependencies: [...dependencies, dbInit, runtime, encryptionKey, ciCertificate],
  });
  return { deployment: app.deployment };
}
