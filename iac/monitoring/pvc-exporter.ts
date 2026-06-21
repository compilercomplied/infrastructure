import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configurePvcExporter(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "pvc-exporter";

  // Read the python exporter script dynamically to comply with the Zero Inline Scripts rule
  const scriptContent = fs.readFileSync(
    path.join(__dirname, "../maintenance/scripts/pvc-exporter.py"),
    "utf-8"
  );

  // 1. ConfigMap to mount the script inside the container
  const configMap = new k8s.core.v1.ConfigMap(`${name}-script`, {
    metadata: {
      name: `${name}-script`,
      namespace,
    },
    data: {
      "pvc-exporter.py": scriptContent,
    },
  }, { dependsOn: dependencies });

  // 2. DaemonSet running on k3s control-plane/nodes
  const daemonSet = new k8s.apps.v1.DaemonSet(name, {
    metadata: {
      name,
      namespace,
      labels: { app: name },
    },
    spec: {
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          // Mount hostPath of local-path storage so we can read directory sizes
          containers: [{
            name: "exporter",
            image: "python:3.11-alpine",
            command: ["python", "/app/pvc-exporter.py"],
            ports: [{ containerPort: 9123, name: "metrics" }],
            volumeMounts: [
              {
                name: "script",
                mountPath: "/app",
              },
              {
                name: "storage",
                mountPath: "/host/storage",
                readOnly: true,
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
            {
              name: "storage",
              hostPath: {
                path: "/var/lib/rancher/k3s/storage",
              },
            },
          ],
        },
      },
    },
  }, { dependsOn: [configMap] });

  // 3. Service to expose the metrics endpoint
  const service = new k8s.core.v1.Service(name, {
    metadata: {
      name,
      namespace,
      labels: { app: name },
    },
    spec: {
      ports: [{ port: 9123, targetPort: 9123, protocol: "TCP", name: "metrics" }],
      selector: { app: name },
    },
  }, { dependsOn: daemonSet });

  // 4. ServiceMonitor for Prometheus Operator to scrape metrics automatically
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
        interval: "30s",
      }],
    },
  }, { dependsOn: [service] });

  return {
    configMap,
    daemonSet,
    service,
    serviceMonitor,
  };
}
