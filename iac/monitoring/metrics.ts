import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configureMetrics(
  namespace: pulumi.Input<string>, dependencies: pulumi.Resource[] = []
) {
  const kubePrometheusStack = new k8s.helm.v3.Chart("kube-prometheus-stack", {
    namespace: namespace,
    chart: "kube-prometheus-stack",
    version: "81.2.1",
    fetchOpts: {
      repo: "https://prometheus-community.github.io/helm-charts",
    },
    values: {
      // We skip CRD installation here because we manage them explicitly to
      // avoid race conditions.
      crds: {
        enabled: false,
      },
      prometheus: {
        prometheusSpec: {
          // This ensures Prometheus scrapes any ServiceMonitor in the cluster,
          // not just its own.
          serviceMonitorSelectorNilUsesHelmValues: false,
          retention: "90d",
        },
      },
      grafana: {
        additionalDataSources: [
          {
            name: "Loki",
            type: "loki",
            uid: "loki",
            url: "http://loki.monitoring.svc.cluster.local:3100",
            access: "proxy",
          },
          {
            name: "Tempo",
            type: "tempo",
            uid: "tempo",
            url: "http://tempo.monitoring.svc.cluster.local:3100",
            access: "proxy",
            jsonData: {
              nodeGraph: {
                enabled: true,
              },
            },
          },
        ],
      },
    },
  },
    {
      providers: {
        kubernetes: new k8s.Provider("k8s-provider", { namespace: namespace })
      },
      dependsOn: dependencies,
    });

  return kubePrometheusStack;
}
