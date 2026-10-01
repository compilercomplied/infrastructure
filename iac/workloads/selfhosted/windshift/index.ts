import { windshiftIdentity } from "./identity";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp } from "../../../library/selfhosted-component";
import { Labels } from "../labels";
import { windshiftSettings } from "./settings";
import { oidcClientSecret, oidcIssuer } from "../../../library/oidc-app";

const windshiftImage = "ghcr.io/windshiftapp/windshift@sha256:98292b54b55ff1414bc315d9cd852edbe452f14f4fad436073166cebfa921a23";
const bootstrapImage = "python:3.11-alpine";

const bootstrapScript = fs.readFileSync(path.join(__dirname, "scripts", "bootstrap.py"), "utf8");

export function configureWindshift(namespace: pulumi.Input<string>, dependencies: pulumi.Resource[] = []) {
  const name = "windshift";
  const config = new pulumi.Config("selfhosted");
  const bootstrapConfig = {
    "BOOTSTRAP_ADMIN_EMAIL": config.requireSecret("user-gdario-email"),
    "BOOTSTRAP_ADMIN_PASSWORD": config.requireSecret("windshiftBootstrapPassword"),
    "OIDC_CLIENT_SECRET": oidcClientSecret(windshiftIdentity, config),
    "OIDC_CLIENT_ID": windshiftIdentity.clientId,
    "OIDC_ISSUER": oidcIssuer(windshiftIdentity),
    "OIDC_SCOPES": windshiftIdentity.scopes.join(" "),
    "WINDSHIFT_ORIGIN": windshiftIdentity.url,
  };
  const bootstrapConfigMap = new k8s.core.v1.ConfigMap(`${name}-bootstrap-script`, {
    metadata: { name: `${name}-bootstrap-script`, namespace },
    data: { "bootstrap-windshift.py": bootstrapScript },
  }, { dependsOn: dependencies });
  const bootstrapSecret = new k8s.core.v1.Secret(`${name}-bootstrap`, {
    metadata: { name: `${name}-bootstrap`, namespace },
    stringData: bootstrapConfig,
  }, { dependsOn: dependencies });
  const bootstrapChecksum = pulumi.all(Object.values(bootstrapConfig)).apply(values =>
    crypto.createHash("sha256").update(values.join("\n") + bootstrapScript).digest("hex"));

  const app = new SelfhostedApp(name, {
    namespace,
    image: windshiftImage,
    endpoints: [{
      name: "http",
      servicePort: 80,
      containerPort: 8080,
      ingress: { name, host: windshiftIdentity.host },
      healthCheck: { protocol: "http", path: "/readyz" },
      allowIngressFrom: [{ podSelector: { app: `${name}-bootstrap` } }],
    }],
    labels: { [Labels.Network.AllowAuthentik]: "true" },
    settings: windshiftSettings,
    volumes: [{ name: "data", mountPath: "/data", size: "5Gi" }],
    additionalVolumes: [{ name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } }],
    additionalVolumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
    podSecurityContext: { fsGroup: 65534, fsGroupChangePolicy: "OnRootMismatch" },
    readinessProbe: { httpGet: { path: "/readyz", port: 8080 }, initialDelaySeconds: 10, periodSeconds: 10, failureThreshold: 6 },
    livenessProbe: { httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 30, periodSeconds: 30, failureThreshold: 3 },
    resources: { requests: { cpu: "100m", memory: "512Mi" }, limits: { cpu: "1", memory: "768Mi" } },
    dependencies: [...dependencies, bootstrapSecret],
  });

  const bootstrap = new k8s.batch.v1.Job(`${name}-bootstrap`, {
    metadata: { name: `${name}-bootstrap`, namespace, annotations: { "bootstrap-checksum": bootstrapChecksum } },
    spec: {
      backoffLimit: 6,
      template: {
        metadata: { labels: { app: `${name}-bootstrap` }, annotations: { "bootstrap-checksum": bootstrapChecksum } },
        spec: {
          restartPolicy: "OnFailure",
          containers: [{
            name: "bootstrap",
            image: bootstrapImage,
            command: ["python", "/scripts/bootstrap-windshift.py"],
            volumeMounts: [{ name: "bootstrap-script", mountPath: "/scripts", readOnly: true }],
            env: Object.keys(bootstrapConfig).map(name => ({
              name,
              valueFrom: { secretKeyRef: { name: bootstrapSecret.metadata.name, key: name } },
            })),
          }],
          volumes: [{ name: "bootstrap-script", configMap: { name: bootstrapConfigMap.metadata.name } }],
        },
      },
    },
  }, { dependsOn: [app.deployment, app.service, bootstrapSecret, bootstrapConfigMap], replaceOnChanges: ["metadata.annotations"], deleteBeforeReplace: true });

  return { deployment: app.deployment, bootstrap };
}
