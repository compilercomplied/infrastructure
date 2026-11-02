import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import { createPostgresBootstrap } from "../../../library/postgres-bootstrap";
import { SelfhostedApp } from "../../../library/selfhosted-component";
import { Labels } from "../labels";
import { excalidashSettings } from "./settings";
import { excalidashIdentity } from "./identity";

const backendImage = "zimengxiong/excalidash-backend:0.6.7";
const frontendImage = "zimengxiong/excalidash-frontend:0.6.5";


export function configureExcaliDash(namespace: pulumi.Input<string>, dependencies: pulumi.Resource[] = []) {
  const name = "excalidash";
  const dbInit = createPostgresBootstrap({
    name,
    namespace,
    databasePassword: excalidashSettings.databasePassword,
    adminPassword: new pulumi.Config("selfhosted").requireSecret("postgresPassword"),
    scriptPaths: [path.join(__dirname, "scripts", "postgres_bootstrap.sql")],
    dependencies,
    resourceNames: {
      configMap: `${name}-db-init-script`,
      secret: `${name}-db-init`,
      checksumAnnotation: "db-init-checksum",
    },
  });

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
