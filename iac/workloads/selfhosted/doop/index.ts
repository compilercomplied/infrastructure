import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp } from "../../../library/selfhosted-component";
import { createPostgresBootstrap } from "../../../library/postgres-bootstrap";
import { Labels } from "../labels";
import { doopIdentity } from "./identity";
import { DoopSettings } from "./settings";

const image = fs.readFileSync(path.join(__dirname, "image.txt"), "utf8").trim();

export function configureDoop(namespace: pulumi.Input<string>, dependencies: pulumi.Resource[] = []) {
  const name = "doop";
  const settings = new DoopSettings();
  const proxyConfig = "map $http_upgrade $connection_upgrade { default upgrade; '' close; }\n" + fs.readFileSync(path.join(__dirname, "nginx.conf"), "utf8");
  const proxy = new k8s.core.v1.ConfigMap(`${name}-proxy`, {
    metadata: { name: `${name}-proxy`, namespace },
    data: { "default.conf": proxyConfig },
  });
  const dbInit = createPostgresBootstrap({
    name,
    namespace,
    databasePassword: settings.databasePassword,
    adminPassword: new pulumi.Config("selfhosted").requireSecret("postgresPassword"),
    scriptPaths: [path.join(__dirname, "scripts/postgres_bootstrap.sql")],
    dependencies,
  });
  const app = new SelfhostedApp(name, {
    namespace,
    image,
    settings,
    // In-memory canvas state and local-path storage both require a single writer.
    strategy: { type: "Recreate" },
    labels: { [Labels.Network.AllowPostgres]: "true", [Labels.Network.AllowAuthentik]: "true" },
    endpoints: [{
      name: "http",
      containerPort: 8080,
      servicePort: 80,
      ingress: { host: doopIdentity.host },
      healthCheck: { protocol: "http", path: "/healthz" },
    }],
    readinessProbe: { httpGet: { path: "/healthz", port: 4400 }, initialDelaySeconds: 10, periodSeconds: 10 },
    livenessProbe: { httpGet: { path: "/healthz", port: 4400 }, initialDelaySeconds: 60, periodSeconds: 30 },
    resources: { requests: { cpu: "100m", memory: "512Mi" }, limits: { cpu: "2", memory: "2Gi" } },
    automountServiceAccountToken: false,
    volumes: [{ name: "data", mountPath: "/app/data", size: "20Gi" }],
    databases: [{ type: "postgres", databaseName: name, username: name, host: "shared-postgres.shared-resources.svc.cluster.local", passwordSecret: settings.databasePassword }],
    podAnnotations: { "doop-proxy-checksum": crypto.createHash("sha256").update(proxyConfig).digest("hex") },
    additionalVolumes: [{ name: "proxy", configMap: { name: proxy.metadata.name } }],
    additionalContainers: [{
      name: "proxy",
      image: fs.readFileSync(path.join(__dirname, "proxy-image.txt"), "utf8").trim(),
      volumeMounts: [{ name: "proxy", mountPath: "/etc/nginx/conf.d", readOnly: true }],
      readinessProbe: { httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 10, periodSeconds: 10 },
      resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { cpu: "250m", memory: "128Mi" } },
    }],
    dependencies: [...dependencies, dbInit, proxy],
  });
  return { deployment: app.deployment };
}
