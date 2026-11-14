import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { SelfhostedApp } from "../../../library/selfhosted-component";
import { createPostgresBootstrap } from "../../../library/postgres-bootstrap";
import { secureWorkloadContainer, workloadPodSecurityContext } from "../../../library/workload-security";
import { appAccess } from "../../../library/app-access";
import { Labels } from "../../../workloads/selfhosted/labels";

export const keycloakImage = "quay.io/keycloak/keycloak:26.8.2";
const bootstrapImage = "python:3.15-alpine";
const host = "keycloak.gdario.dev";
const databaseHost = "shared-postgres.shared-resources.svc.cluster.local";

export function configureKeycloak(namespace: pulumi.Input<string>, dependencies: pulumi.Resource[]) {
  if (appAccess.entryPoints(host) !== "tailnet") {
    throw new Error(`${host} must use private access before deploying Keycloak`);
  }
  const password = (name: string) => pulumi.secret(new random.RandomPassword(`keycloak-${name}`, {
    length: 48, special: false,
  }).result);
  const databasePassword = password("database-password");
  const bootstrapPassword = password("bootstrap-secret");
  const automationSecret = password("automation-secret");
  const bootstrapClientId = "bootstrap-iac";
  const automationClientId = "pulumi";
  const dbInit = createPostgresBootstrap({
    name: "keycloak", namespace, databasePassword,
    adminPassword: new pulumi.Config("selfhosted").requireSecret("postgresPassword"),
    automountServiceAccountToken: false,
    scriptPaths: [path.join(__dirname, "scripts", "postgres_bootstrap.sql")], dependencies,
  });
  const app = new SelfhostedApp("keycloak", {
    namespace, image: keycloakImage,
    args: ["start"],
    // A single node needs neither distributed cache discovery nor overlapping schema migrations.
    strategy: { type: "Recreate" },
    automountServiceAccountToken: false,
    settings: {
      config: {
        KC_DB: "postgres", KC_DB_URL: `jdbc:postgresql://${databaseHost}:5432/keycloak`,
        KC_DB_USERNAME: "keycloak", KC_HOSTNAME: `https://${host}`,
        KC_HTTP_ENABLED: "true", KC_PROXY_HEADERS: "xforwarded",
        KC_HEALTH_ENABLED: "true", KC_METRICS_ENABLED: "true", KC_CACHE: "local",
        KC_BOOTSTRAP_ADMIN_CLIENT_ID: bootstrapClientId,
      },
      secrets: { KC_DB_PASSWORD: databasePassword, KC_BOOTSTRAP_ADMIN_CLIENT_SECRET: bootstrapPassword },
    },
    endpoints: [{
      name: "http", containerPort: 8080, servicePort: 80,
      ingress: { name: "keycloak", host },
      allowIngressFrom: [{ podSelector: { app: "keycloak-bootstrap" } }],
    }],
    labels: { [Labels.Network.AllowPostgres]: "true" },
    podSecurityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 },
    readinessProbe: { httpGet: { path: "/health/ready", port: 9000 }, periodSeconds: 10, failureThreshold: 6 },
    livenessProbe: { httpGet: { path: "/health/live", port: 9000 }, initialDelaySeconds: 180, periodSeconds: 15, failureThreshold: 6 },
    resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "2", memory: "1Gi" } },
    databases: [{ type: "postgres", host: databaseHost, databaseName: "keycloak", username: "keycloak", passwordSecret: databasePassword }],
    dependencies: [...dependencies, dbInit],
  });
  const script = fs.readFileSync(path.join(__dirname, "scripts", "bootstrap.py"), "utf8");
  const scriptHash = crypto.createHash("sha256").update(script).digest("hex");
  const scripts = new k8s.core.v1.ConfigMap("keycloak-bootstrap-script", {
    metadata: { name: `keycloak-bootstrap-${scriptHash.slice(0, 16)}`, namespace },
    data: { "bootstrap.py": script },
  }, { dependsOn: dependencies });
  const credentials = {
    BOOTSTRAP_CLIENT_SECRET: bootstrapPassword, AUTOMATION_CLIENT_SECRET: automationSecret,
  };
  const secret = new k8s.core.v1.Secret("keycloak-automation", {
    metadata: { name: "keycloak-automation", namespace }, stringData: credentials,
  }, { dependsOn: dependencies });
  const checksum = pulumi.all([bootstrapPassword, automationSecret]).apply(values =>
    crypto.createHash("sha256").update(JSON.stringify([scriptHash, ...values])).digest("hex"));
  const bootstrap = new k8s.batch.v1.Job("keycloak-bootstrap", {
    metadata: { name: "keycloak-bootstrap", namespace, annotations: { "bootstrap-checksum": checksum } },
    spec: {
      backoffLimit: 3, activeDeadlineSeconds: 300,
      template: {
        metadata: { labels: { app: "keycloak-bootstrap" }, annotations: { "bootstrap-checksum": checksum } },
        spec: {
          restartPolicy: "Never", automountServiceAccountToken: false,
          securityContext: workloadPodSecurityContext({ runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 }),
          containers: [secureWorkloadContainer({
            name: "bootstrap", image: bootstrapImage, command: ["python", "-B", "/scripts/bootstrap.py"],
            securityContext: { readOnlyRootFilesystem: true },
            env: [
              { name: "KEYCLOAK_URL", value: "http://keycloak.infrastructure.svc.cluster.local" },
              { name: "BOOTSTRAP_CLIENT_ID", value: bootstrapClientId },
              { name: "AUTOMATION_CLIENT_ID", value: automationClientId },
              ...Object.keys(credentials).map(name => ({ name, valueFrom: { secretKeyRef: { name: secret.metadata.name, key: name } } })),
            ],
            volumeMounts: [{ name: "script", mountPath: "/scripts", readOnly: true }],
            resources: { requests: { cpu: "25m", memory: "32Mi" }, limits: { cpu: "250m", memory: "64Mi" } },
          })],
          volumes: [{ name: "script", configMap: { name: scripts.metadata.name } }],
        },
      },
    },
  }, {
    dependsOn: [app.service, ...app.internalPolicies, secret, scripts],
    replaceOnChanges: ["metadata.annotations"], deleteBeforeReplace: true,
  });
  return { app, bootstrap, automationClientId, automationSecret, url: `https://${host}` };
}
