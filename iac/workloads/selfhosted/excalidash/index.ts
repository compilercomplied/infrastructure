import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp } from "../../../library/selfhosted-component";
import { postgresClientImage } from "../../../platform/shared-resources/shared-postgres";
import { Labels } from "../labels";
import { excalidashSettings } from "./settings";
import { excalidashIdentity } from "./identity";

const backendImage = "zimengxiong/excalidash-backend@sha256:29937c62fbed5f4d417398c21c7ab261965231427bd5ae3c64f8d365fe2c02a3";
const frontendImage = "zimengxiong/excalidash-frontend@sha256:333a3f24bd599f69ebb3494e0393b6882f2f031fc0f05d02b0ede53ce7a743e0";
const dbInitScript = fs.readFileSync(path.join(__dirname, "../../../operations/maintenance/scripts/init-forgejo-db.sh"), "utf8");

export function configureExcaliDash(namespace: pulumi.Input<string>, dependencies: pulumi.Resource[] = []) {
  const name = "excalidash";
  const config = new pulumi.Config("selfhosted");
  const dbInitScriptConfigMap = new k8s.core.v1.ConfigMap(`${name}-db-init-script`, {
    metadata: { name: `${name}-db-init-script`, namespace },
    data: { "init-forgejo-db.sh": dbInitScript },
  }, { dependsOn: dependencies });
  const dbInitSecret = new k8s.core.v1.Secret(`${name}-db-init`, {
    metadata: { name: `${name}-db-init`, namespace },
    stringData: {
      DB_PASSWORD: excalidashSettings.databasePassword,
      ADMIN_PASSWORD: config.requireSecret("postgresPassword"),
    },
  }, { dependsOn: dependencies });
  const dbInitChecksum = pulumi.all([
    excalidashSettings.databasePassword,
    config.requireSecret("postgresPassword"),
    dbInitScript,
  ]).apply(([databasePassword, adminPassword, script]) =>
    crypto.createHash("sha256").update(databasePassword + adminPassword + script).digest("hex"));
  const dbInit = new k8s.batch.v1.Job(`init-${name}-db`, {
    metadata: { namespace, annotations: { "db-init-checksum": dbInitChecksum } },
    spec: {
      template: {
        metadata: {
          labels: { [Labels.Network.AllowPostgres]: "true" },
          annotations: { "db-init-checksum": dbInitChecksum },
        },
        spec: {
          restartPolicy: "Never",
          containers: [{
            name: "db-init",
            image: postgresClientImage,
            command: ["/bin/sh", "/scripts/init-forgejo-db.sh"],
            env: [
              { name: "DB_HOST", value: "shared-postgres.shared-resources.svc.cluster.local" },
              { name: "DB_NAME", value: name },
              { name: "DB_USER", value: name },
              { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: dbInitSecret.metadata.name, key: "DB_PASSWORD" } } },
              { name: "ADMIN_PASSWORD", valueFrom: { secretKeyRef: { name: dbInitSecret.metadata.name, key: "ADMIN_PASSWORD" } } },
            ],
            volumeMounts: [{ name: "scripts", mountPath: "/scripts", readOnly: true }],
          }],
          volumes: [{ name: "scripts", configMap: { name: dbInitScriptConfigMap.metadata.name, defaultMode: 0o755 } }],
        },
      },
    },
  }, { dependsOn: [dbInitScriptConfigMap, dbInitSecret, ...dependencies], replaceOnChanges: ["metadata.annotations"], deleteBeforeReplace: true });

  const app = new SelfhostedApp(name, {
    namespace,
    image: backendImage,
    endpoints: [{
      name: "http",
      servicePort: 80,
      containerPort: 80,
      ingress: { name, host: excalidashIdentity.host },
      healthCheck: { protocol: "http", path: "/api/health" },
    }],
    labels: {
      [Labels.Network.AllowPostgres]: "true",
      [Labels.Network.AllowAuthentik]: "true",
    },
    ipFamilyPolicy: "SingleStack",
    ipFamilies: ["IPv4"],
    settings: excalidashSettings,
    databases: [{
      type: "postgres",
      databaseName: name,
      host: "shared-postgres.shared-resources.svc.cluster.local",
      username: name,
      passwordSecret: excalidashSettings.databasePassword,
    }],
    readinessProbe: { httpGet: { path: "/health", port: 8000 }, initialDelaySeconds: 10, periodSeconds: 10, failureThreshold: 6 },
    livenessProbe: { httpGet: { path: "/health", port: 8000 }, initialDelaySeconds: 30, periodSeconds: 30, failureThreshold: 3 },
    resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "1", memory: "512Mi" } },
    additionalContainers: [{
      name: "frontend",
      image: frontendImage,
      ports: [{ name: "frontend-http", containerPort: 80 }],
      env: [{ name: "BACKEND_URL", value: "127.0.0.1:8000" }],
      readinessProbe: { httpGet: { path: "/", port: 80 }, initialDelaySeconds: 5, periodSeconds: 10, failureThreshold: 3 },
      livenessProbe: { httpGet: { path: "/", port: 80 }, initialDelaySeconds: 30, periodSeconds: 30, failureThreshold: 3 },
      resources: { requests: { cpu: "25m", memory: "64Mi" }, limits: { cpu: "250m", memory: "128Mi" } },
    }],
    dependencies: [...dependencies, dbInit],
  });

  return { deployment: app.deployment };
}
