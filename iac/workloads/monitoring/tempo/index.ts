import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export const tempoLabel = { app: "tempo" };
export const alloyLabel = { "app.kubernetes.io/name": "alloy" };

export function configureTempo(namespace: pulumi.Input<string>) {
  const config = new k8s.core.v1.ConfigMap("tempo-config", {
    metadata: { name: "tempo-config", namespace },
    data: {
      "tempo.yaml": readFileSync(join(__dirname, "tempo.yaml"), "utf8"),
    },
  });
  const data = new k8s.core.v1.PersistentVolumeClaim("tempo-data", {
    metadata: { name: "tempo-data", namespace },
    spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "5Gi" } } },
  }, { protect: true, retainOnDelete: true });
  const network = new k8s.networking.v1.NetworkPolicy("tempo-ingress", {
    metadata: { name: "tempo-ingress", namespace },
    spec: {
      podSelector: { matchLabels: tempoLabel },
      policyTypes: ["Ingress"],
      ingress: [
        { from: [{ podSelector: { matchLabels: alloyLabel } }], ports: [{ protocol: "TCP", port: 4318 }] },
        { from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "grafana" } } }],
          ports: [{ protocol: "TCP", port: 3200 }] },
      ],
    },
  });
  const deployment = new k8s.apps.v1.Deployment("tempo", {
    metadata: { name: "tempo", namespace },
    spec: {
      replicas: 1,
      // One Tempo process owns the local WAL and blocks.
      strategy: { type: "Recreate" },
      selector: { matchLabels: tempoLabel },
      template: {
        metadata: { labels: tempoLabel, annotations: { "tempo/config-sha": config.data.apply(data =>
          crypto.createHash("sha256").update(data?.["tempo.yaml"] ?? "").digest("hex")) } },
        spec: {
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001 },
          containers: [{
            name: "tempo",
            image: "docker.io/grafana/tempo:2.8.4",
            args: ["-config.file=/etc/tempo/tempo.yaml"],
            ports: [{ name: "http", containerPort: 3200 }, { name: "otlp-http", containerPort: 4318 }],
            readinessProbe: { httpGet: { path: "/ready", port: "http" } },
            startupProbe: { httpGet: { path: "/ready", port: "http" }, failureThreshold: 30, periodSeconds: 5 },
            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
            resources: { requests: { cpu: "50m", memory: "192Mi" }, limits: { memory: "512Mi" } },
            volumeMounts: [
              { name: "config", mountPath: "/etc/tempo", readOnly: true },
              { name: "data", mountPath: "/var/tempo" },
            ],
          }],
          volumes: [
            { name: "config", configMap: { name: config.metadata.name } },
            { name: "data", persistentVolumeClaim: { claimName: data.metadata.name } },
          ],
        },
      },
    },
  }, { dependsOn: [network] });
  const service = new k8s.core.v1.Service("tempo", {
    metadata: { name: "tempo", namespace },
    spec: { selector: tempoLabel, ports: [
      { name: "http", port: 3200, targetPort: "http" },
      { name: "otlp-http", port: 4318, targetPort: "otlp-http" },
    ] },
  }, { dependsOn: [deployment] });
  new k8s.core.v1.ConfigMap("tempo-datasource", {
    metadata: { name: "tempo-datasource", namespace, labels: { grafana_datasource: "1" } },
    data: {
      "tempo-datasource.yaml": JSON.stringify({
        apiVersion: 1,
        datasources: [{ name: "Tempo", uid: "tempo", type: "tempo", access: "proxy", url: "http://tempo:3200" }],
      }),
    },
  }, { dependsOn: [service] });
  return service;
}
