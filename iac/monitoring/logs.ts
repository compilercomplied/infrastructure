import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configureLogs(namespace: pulumi.Input<string>) {
  const loki = new k8s.helm.v3.Chart("loki", {
    namespace: namespace,
    chart: "loki-stack",
    fetchOpts: {
      repo: "https://grafana.github.io/helm-charts",
    },
    values: {
      loki: {
        persistence: {
          enabled: true,
          size: "10Gi",
        },
        config: {
          limits_config: {
            // 90 days.
            retention_period: "2160h",
          },
          compactor: {
            working_directory: "/data/loki/boltdb-shipper-compactor",
            shared_store: "filesystem",
            retention_enabled: true,
          },
        },
      },
      promtail: {
        enabled: true,
      },
      // Disable bundled Grafana and Prometheus as they are already provided
      // by kube-prometheus-stack.
      grafana: { enabled: false },
      prometheus: { enabled: false },
    },
  },
    {
      providers:
      {
        kubernetes: new k8s.Provider("loki-k8s-provider",
          {
            namespace: namespace
          }
        )
      }
    });

    const eventExporter = new k8s.helm.v3.Chart("event-exporter", {

      namespace: namespace,

      chart: "kubernetes-event-exporter",

      fetchOpts: {

        repo: "https://charts.resmo.com",

      },

      values: {

        config: {

          // Configure it to dump events to stdout so Promtail can pick them up

          receivers: [{

            name: "stdout",

            stdout: {},

          }],

          route: {

            routes: [{

              match: [{ receiver: "stdout" }],

            }],

          },

        },

      },

    }, { providers: { kubernetes: new k8s.Provider("event-exporter-provider", { namespace: namespace }) } });

  

  return { loki, eventExporter };
}
