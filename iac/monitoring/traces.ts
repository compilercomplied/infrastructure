import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configureTraces(namespace: pulumi.Input<string>) {
  const tempo = new k8s.helm.v3.Chart("tempo", {
    namespace: namespace,
    chart: "tempo",
    fetchOpts: {
      repo: "https://grafana.github.io/helm-charts",
    },
    values: {
      storage: {
        trace: {
          backend: "local",
          local: {
            path: "/var/tempo/traces",
          },
          wal: {
            path: "/var/tempo/wal",
          },
        },
      },
      persistence: {
        enabled: true,
        size: "10Gi",
      },
      tempo: {
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
      },
    },
  }, { providers: { kubernetes: new k8s.Provider("tempo-provider", { namespace: namespace }) } });

  return tempo;
}
