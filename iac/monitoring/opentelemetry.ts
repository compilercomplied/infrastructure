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
      image: {
        repository: "otel/opentelemetry-collector-contrib",
        tag: "0.110.0",
      },
      config: {
        receivers: {
          otlp: {
            protocols: {
              grpc: {
                endpoint: "0.0.0.0:4317",
              },
              http: {
                endpoint: "0.0.0.0:4318",
              },
            },
          },
        },
        processors: {
          batch: {},
        },
        exporters: {
          otlp: {
            endpoint: "tempo:4317",
            tls: {
              insecure: true,
            },
          },
          loki: {
            endpoint: "http://loki:3100/loki/api/v1/push",
          },
          prometheusremotewrite: {
            endpoint: "http://kube-prometheus-stack-prometheus:9090/api/v1/write",
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
  },
    {
      providers:
      {
        kubernetes: new k8s.Provider("otel-collector-provider",
          {
            namespace: namespace
          }
        )
      }
    }
  );

  return opentelemetryCollector;
}
