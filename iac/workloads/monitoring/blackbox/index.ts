import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configureBlackboxExporter(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "blackbox-exporter";

  const config = new k8s.core.v1.ConfigMap(`${name}-config`, {
    metadata: { name: `${name}-config`, namespace },
    data: {
      "blackbox.yml": `modules:
  http_2xx:
    prober: http
    timeout: 10s
    http:
      method: GET
      preferred_ip_protocol: ip4
      valid_status_codes: [200, 201, 202, 204]
  tcp_connect:
    prober: tcp
    timeout: 10s
    tcp:
      preferred_ip_protocol: ip4
`,
    },
  }, { dependsOn: dependencies });

  const deployment = new k8s.apps.v1.Deployment(name, {
    metadata: { name, namespace, labels: { app: name } },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          containers: [{
            name,
            image: "quay.io/prometheus/blackbox-exporter:v0.27.0",
            args: ["--config.file=/config/blackbox.yml"],
            ports: [{ name: "http", containerPort: 9115 }],
            readinessProbe: {
              httpGet: { path: "/-/ready", port: 9115 },
              periodSeconds: 10,
              failureThreshold: 3,
            },
            livenessProbe: {
              httpGet: { path: "/-/healthy", port: 9115 },
              periodSeconds: 30,
              failureThreshold: 3,
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
            resources: {
              requests: { cpu: "10m", memory: "32Mi" },
              limits: { cpu: "100m", memory: "64Mi" },
            },
            volumeMounts: [{ name: "config", mountPath: "/config", readOnly: true }],
          }],
          volumes: [{ name: "config", configMap: { name: config.metadata.name } }],
        },
      },
    },
  }, { dependsOn: [config] });

  const service = new k8s.core.v1.Service(name, {
    metadata: { name, namespace, labels: { app: name } },
    spec: {
      selector: { app: name },
      ports: [{ name: "http", port: 9115, targetPort: 9115 }],
    },
  }, { dependsOn: deployment });

  return { config, deployment, service };
}
