import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configureOpenTelemetry(namespace: pulumi.Input<string>) {
  const opentelemetryCollector = new k8s.helm.v3.Chart("opentelemetry-collector", {
    namespace: namespace,
    chart: "opentelemetry-collector",
    fetchOpts: {
      repo: "https://open-telemetry.github.io/opentelemetry-helm-charts",
    },
    values: {
      mode: "deployment",
      config: {
        receivers: {
          otlp: {
            protocols: {
              grpc: {},
              http: {},
            },
          },
        },
        processors: {
          batch: {},
        },
        exporters: {
          otlp: { // Export traces to Tempo
            endpoint: "tempo.monitoring.svc.cluster.local:4317",
            tls: {
              insecure: true,
            },
          },
          loki: { // Export logs to Loki
            endpoint: "http://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push",
          },
          prometheusremotewrite: { // Export metrics to Prometheus
            endpoint: "http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090/api/v1/write",
          },
        },
        service: {
          pipelines: {
            traces: {
              receivers: ["otlp"],
              processors: ["batch"],
              exporters: ["otlp"],
            },
            metrics: {
              receivers: ["otlp"],
              processors: ["batch"],
              exporters: ["prometheusremotewrite"],
            },
            logs: {
              receivers: ["otlp"],
              processors: ["batch"],
              exporters: ["loki"],
            },
          },
        },
      },
    },
  }, { providers: { kubernetes: new k8s.Provider("otel-collector-provider", { namespace: namespace }) } });

  return opentelemetryCollector;
}
