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
        // We set isDefault to false because kube-prometheus-stack already
        // provides Prometheus as the default datasource. Grafana only
        // supports one default datasource per organization.
        isDefault: false,
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


  // The event exporter was super annoying to setup. The bitnami chart is
  // documented but instead of this one we should be using the one maintained
	// by linkedin. This could end up being the source of some issues in the
	// future.
  const eventExporter = new k8s.helm.v3.Release("event-exporter", {
    namespace: namespace,
    chart: "kubernetes-event-exporter",
    version: "3.6.3",
    repositoryOpts: {
      repo: "https://charts.bitnami.com/bitnami",
    },
    values: {
      global: {
        security: {
          allowInsecureImages: true,
        },
      },
      image: {
        registry: "public.ecr.aws",
        repository: "bitnami/kubernetes-event-exporter",
        tag: "1.7.0-debian-12-r46",
      },
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
  }, { provider: new k8s.Provider("event-exporter-provider", { namespace: namespace }) });



  return { loki, eventExporter };
}
