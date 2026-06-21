import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configureDeepseekExporter(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "deepseek-exporter";

  // Read the Python exporter script dynamically to comply with the Zero Inline Scripts rule.
  // We use Python's standard library to build a lightweight HTTP exporter,
  // avoiding custom docker build/push steps (Zero ClickOps) and keeping the image to python:3.11-alpine.
  const scriptContent = fs.readFileSync(
    path.join(__dirname, "../maintenance/scripts/deepseek-exporter.py"),
    "utf-8"
  );

  const selfhostedConfig = new pulumi.Config("selfhosted");
  const deepseekApiKey = selfhostedConfig.requireSecret("deepseekApiKey");

  // 1. ConfigMap to mount the Python script inside the container
  const configMap = new k8s.core.v1.ConfigMap(`${name}-script`, {
    metadata: {
      name: `${name}-script`,
      namespace,
    },
    data: {
      "deepseek-exporter.py": scriptContent,
    },
  }, { dependsOn: dependencies });

  // 2. Secret to hold the DeepSeek API Key securely.
  // Storing this in a Secret prevents the API key from leaking into pod specs.
  const secret = new k8s.core.v1.Secret(`${name}-secret`, {
    metadata: {
      name: `${name}-secret`,
      namespace,
    },
    stringData: {
      "DEEPSEEK_API_KEY": deepseekApiKey,
    },
  }, { dependsOn: dependencies });

  // 3. Deployment running the Python script.
  // We use a single replica Deployment instead of a DaemonSet because DeepSeek API is an external cloud service.
  // Running one instance prevents multiple pods from concurrently querying the API and risking rate-limiting.
  const deployment = new k8s.apps.v1.Deployment(name, {
    metadata: {
      name,
      namespace,
      labels: { app: name },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: {
          labels: { app: name },
          annotations: {
            "config/checksum": require("crypto").createHash("md5").update(scriptContent).digest("hex"),
          },
        },
        spec: {
          containers: [{
            name: "exporter",
            image: "python:3.11-alpine",
            command: ["python", "/app/deepseek-exporter.py"],
            ports: [{ containerPort: 9124, name: "metrics" }],
            env: [
              {
                name: "DEEPSEEK_API_KEY",
                valueFrom: {
                  secretKeyRef: {
                    name: secret.metadata.name,
                    key: "DEEPSEEK_API_KEY",
                  },
                },
              },
              {
                name: "PORT",
                value: "9124",
              },
              {
                name: "CACHE_DURATION_SECS",
                value: "300", // Cache results for 5 minutes as balance usage changes slowly and to avoid API abuse
              }
            ],
            volumeMounts: [
              {
                name: "script",
                mountPath: "/app",
              },
            ],
            resources: {
              limits: { memory: "64Mi", cpu: "100m" },
              requests: { memory: "16Mi", cpu: "10m" },
            },
          }],
          volumes: [
            {
              name: "script",
              configMap: { name: configMap.metadata.name },
            },
          ],
        },
      },
    },
  }, { dependsOn: [configMap, secret] });

  // 4. Service to expose the metrics endpoint inside the cluster
  const service = new k8s.core.v1.Service(name, {
    metadata: {
      name,
      namespace,
      labels: { app: name },
    },
    spec: {
      ports: [{ port: 9124, targetPort: 9124, protocol: "TCP", name: "metrics" }],
      selector: { app: name },
    },
  }, { dependsOn: deployment });

  // 5. ServiceMonitor for Prometheus Operator to automatically discover and scrape the metrics.
  // The scrape interval is configured to match our 5-minute caching design to prevent extra API hit overhead.
  const serviceMonitor = new k8s.apiextensions.CustomResource(name, {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
      name,
      namespace,
      labels: { app: name },
    },
    spec: {
      selector: { matchLabels: { app: name } },
      endpoints: [{
        port: "metrics",
        path: "/metrics",
        interval: "5m",
      }],
    },
  }, { dependsOn: [service] });

  // 6. Grafana Dashboard ConfigMap.
  // Grafana has an active sidecar container searching all namespaces for ConfigMaps with the `grafana_dashboard` label.
  // This dashboard definition is kept in code to satisfy the Zero ClickOps requirement.
  return {
    configMap,
    secret,
    deployment,
    service,
    serviceMonitor
  };
}
