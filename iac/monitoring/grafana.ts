import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/**
 * Standalone Grafana Visualization Layer
 */
export function configureGrafana(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config();
  const adminPassword = config.requireSecret("grafanaAdminPassword");

  const grafana = new k8s.helm.v3.Chart("grafana", {
    namespace: namespace,
    chart: "grafana",
    version: "8.10.1",
    fetchOpts: {
      repo: "https://grafana.github.io/helm-charts",
    },
    values: {
      adminPassword: adminPassword,
      persistence: { enabled: true, size: "10Gi" },
      
      plugins: [
        "grafana-lokiexplore-app"
      ],

      "grafana.ini": {
        plugins: {
          enable_alpha: true,
          allow_loading_unsigned_plugins: "grafana-lokiexplore-app"
        }
      },

      service: {
        annotations: {
          "tailscale.com/expose": "true",
          "tailscale.com/hostname": "grafana",
          "tailscale.com/tags": "tag:kubernetes",
        },
      },
      datasources: {
        "datasources.yaml": {
          apiVersion: 1,
          datasources: [
            {
              name: "Prometheus",
              type: "prometheus",
              uid: "prometheus",
              url: "http://kube-prometheus-stack-prometheus:9090",
              access: "proxy",
              isDefault: true,
              jsonData: { httpMethod: "POST", timeInterval: "30s" },
            },
            {
              name: "Loki",
              type: "loki",
              uid: "loki",
              url: "http://loki:3100",
              access: "proxy",
              jsonData: {
                maxLines: 1000,
              },
            },          ],
        },
      },
      sidecar: {
        dashboards: { enabled: true, label: "grafana_dashboard", labelValue: "1", searchNamespace: "ALL" },
        datasources: { enabled: true, label: "grafana_datasource", labelValue: "1", searchNamespace: "ALL" },
      },
    },
  }, {
    providers: { kubernetes: new k8s.Provider("k8s-grafana-provider", { namespace: namespace }) },
    dependsOn: dependencies,
  });

  return grafana;
}
