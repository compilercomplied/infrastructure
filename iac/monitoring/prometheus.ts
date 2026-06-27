import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/**
 * The Prometheus "Metrics Engine"
 * This only installs the Prometheus Operator, Prometheus (the TSDB),
 * and its core internal exporters (kube-state-metrics and node-exporter).
 * Grafana, Alertmanager, and external scrapers are excluded.
 */
export function configurePrometheus(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const kubePrometheusStack = new k8s.helm.v3.Chart("kube-prometheus-stack", {
    namespace: namespace,
    chart: "kube-prometheus-stack",
    version: "81.2.1",
    fetchOpts: {
      repo: "https://prometheus-community.github.io/helm-charts",
    },
    values: {
      // Disable CRD installation here; we manage them explicitly in crds.ts
      crds: {
        enabled: false,
      },

      // Disable Grafana: We will install it as a standalone service in grafana.ts
      grafana: {
        enabled: false,
      },

      // Disable Alertmanager for now; can be enabled later if needed
      alertmanager: {
        enabled: false,
      },

      prometheus: {
        prometheusSpec: {
          // Retention for enterprise-grade: Usually longer or using remote write
          retention: "30d",
          // Ensures any ServiceMonitor in any namespace is scraped
          serviceMonitorSelectorNilUsesHelmValues: false,
          // Storage: Prometheus owns this PVC
          storageSpec: {
            volumeClaimTemplate: {
              spec: {
                accessModes: ["ReadWriteOnce"],
                resources: {
                  requests: {
                    storage: "20Gi",
                  },
                },
              },
            },
          },
        },
      },
      
      // These are core exporters provided by the stack chart
      // We keep them here because they are the "standard" feed for Prometheus
      "prometheus-node-exporter": {
        enabled: true,
        serviceAccount: {
          create: true,
        },
      },
      "kube-state-metrics": {
        enabled: true,
        serviceAccount: {
          create: true,
        },
      },
    },
  },
    {
      dependsOn: dependencies,
    });

  return kubePrometheusStack;
}
