import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/**
 * Loki Log Database (Storage Layer)
 * This installs Loki 3.x in SingleBinary mode for efficient storage of logs.
 */
export function configureLoki(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const loki = new k8s.helm.v3.Chart("loki", {
    namespace: namespace,
    chart: "loki",
    version: "6.21.0", // Latest stable 6.x chart for Loki 3.x
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
        // Retention: 30 days
        limits_config: {
          retention_period: "720h",
        },
        compactor: {
          retention_enabled: true,
          delete_request_store: "filesystem",
        },
      },
      singleBinary: {
        replicas: 1,
        persistence: {
          enabled: true,
          size: "20Gi",
        },
      },
      // Disable components not used in SingleBinary mode
      backend: { replicas: 0 },
      read: { replicas: 0 },
      write: { replicas: 0 },
      gateway: { enabled: false },
      resultsCache: { enabled: false },
      chunksCache: { enabled: false },
      
      // Disable self-monitoring to keep it simple for now
      monitoring: {
        lokiCanary: { enabled: false },
        selfMonitoring: { enabled: false },
      },
      test: { enabled: false },
    },
  },
    {
      providers: {
        kubernetes: new k8s.Provider("k8s-loki-provider", { namespace: namespace })
      },
      dependsOn: dependencies,
    });

  return loki;
}
