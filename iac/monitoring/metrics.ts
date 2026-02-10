import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configureMetrics(
  namespace: pulumi.Input<string>, dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config();
  const adminPassword = config.requireSecret("grafanaAdminPassword");

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
        adminPassword: adminPassword,
        persistence: {
          enabled: true,
          size: "10Gi",
        },
        service: {
          annotations: {
            "tailscale.com/expose": "true",
            // This sets the hostname in your tailnet (e.g., grafana.your-tailnet.ts.net)
            "tailscale.com/hostname": "grafana",
            // This tag must match one configured in your Tailscale Admin Console
            // and allowed by your ACLs for the OAuth client.
            "tailscale.com/tags": "tag:kubernetes",
          },
        },
        // Loki and Tempo are added here because their charts don't provide
        // auto-registration via sidecar ConfigMaps in this setup.
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
