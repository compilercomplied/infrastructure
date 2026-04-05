import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/**
 * Grafana Alloy Log Agent (Scraper/Collector)
 * This acts as a DaemonSet to scrape logs from pods and push them to Loki.
 * Alloy is the modern replacement for Promtail.
 */
export function configureAlloy(
  namespace: pulumi.Input<string>,
  lokiService: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const alloy = new k8s.helm.v3.Chart("alloy", {
    namespace: namespace,
    chart: "alloy",
    version: "0.10.1", // Current stable version of Alloy
    fetchOpts: {
      repo: "https://grafana.github.io/helm-charts",
    },
    values: {
      alloy: {
        config: `
          // Scrape logs from /var/log/pods and push them to Loki
          loki.relabel "journal" {
            forward_to = [loki.write.local.receiver]
            rule {
              source_labels = ["__meta_kubernetes_pod_node_name"]
              target_label  = "node_name"
            }
          }

          discovery.kubernetes "pods" {
            role = "pod"
          }

          loki.source.kubernetes "pod_logs" {
            targets    = discovery.kubernetes.pods.targets
            forward_to = [loki.write.local.receiver]
          }

          loki.write "local" {
            endpoint {
              url = "http://${lokiService}:3100/loki/api/v1/push"
            }
          }
        `,
      },
      controller: {
        type: "daemonset",
      },
    },
  },
    {
      providers: {
        kubernetes: new k8s.Provider("k8s-alloy-provider", { namespace: namespace })
      },
      dependsOn: dependencies,
    });

  return alloy;
}
