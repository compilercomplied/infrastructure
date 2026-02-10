import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configureLogs(namespace: pulumi.Input<string>) {
  // Use the modern loki chart (Loki 3.x) instead of the deprecated loki-stack
  // chart. Loki 3.x is required for the /index/volume API that Grafana 11+
  // uses in the Explore Logs view.
  const loki = new k8s.helm.v3.Chart("loki", {
    namespace: namespace,
    chart: "loki",
    fetchOpts: {
      repo: "https://grafana.github.io/helm-charts",
    },
    values: {
      deploymentMode: "SingleBinary",
      loki: {
        auth_enabled: false,
        commonConfig: {
          replication_factor: 1,
        },
        storage: {
          type: "filesystem",
        },
        limits_config: {
          // 90 days.
          retention_period: "2160h",
        },
        compactor: {
          working_directory: "/var/loki/compactor",
          retention_enabled: true,
          delete_request_store: "filesystem",
        },
        schemaConfig: {
          configs: [
            {
              from: "2024-01-01",
              store: "tsdb",
              object_store: "filesystem",
              schema: "v13",
              index: {
                prefix: "index_",
                period: "24h",
              },
            },
          ],
        },
      },
      singleBinary: {
        replicas: 1,
        persistence: {
          enabled: true,
          size: "10Gi",
        },
      },
      // Disable components not needed in single binary mode.
      backend: { replicas: 0 },
      read: { replicas: 0 },
      write: { replicas: 0 },
      gateway: { enabled: false },
      chunksCache: { enabled: false },
      resultsCache: { enabled: false },
      monitoring: {
        lokiCanary: { enabled: false },
        selfMonitoring: {
          enabled: false,
          grafanaAgent: { installOperator: false },
        },
      },
      test: { enabled: false },
    },
  }, {
    providers: {
      kubernetes: new k8s.Provider("loki-k8s-provider", {
        namespace: namespace,
      }),
    },
  });

  const promtail = new k8s.helm.v3.Chart("promtail", {
    namespace: namespace,
    chart: "promtail",
    fetchOpts: {
      repo: "https://grafana.github.io/helm-charts",
    },
    values: {
      config: {
        clients: [
          { url: "http://loki:3100/loki/api/v1/push" },
        ],
      },
    },
  }, {
    providers: {
      kubernetes: new k8s.Provider("promtail-k8s-provider", {
        namespace: namespace,
      }),
    },
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



  return { loki, promtail, eventExporter };
}
