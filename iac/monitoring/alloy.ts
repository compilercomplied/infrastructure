import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/**
 * Grafana Alloy Log Agent (Scraper/Collector)
 */
export function configureAlloy(
  namespace: pulumi.Input<string>,
  lokiService: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const alloyConfig = `
discovery.kubernetes "pods" {
  role = "pod"
}

discovery.relabel "pod_logs" {
  targets = discovery.kubernetes.pods.targets

  // Correct path for standard K8s: /var/log/pods/<namespace>_<pod_name>_<pod_uid>/<container_name>/*.log
  rule {
    source_labels = [
      "__meta_kubernetes_namespace",
      "__meta_kubernetes_pod_name",
      "__meta_kubernetes_pod_uid",
      "__meta_kubernetes_pod_container_name",
    ]
    separator     = "_"
    action        = "replace"
    replacement   = "/var/log/pods/\${1}_\${2}_\${3}/\${4}/*.log"
    target_label  = "__path__"
  }

  // 1:1 Metadata Mapping
  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }

  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    target_label  = "pod"
  }

  rule {
    source_labels = ["__meta_kubernetes_pod_container_name"]
    target_label  = "container"
  }

  rule {
    source_labels = ["__meta_kubernetes_pod_node_name"]
    target_label  = "node_name"
  }

  rule {
    source_labels = ["__meta_kubernetes_pod_label_app"]
    target_label  = "app"
  }

  rule {
    source_labels = ["__meta_kubernetes_pod_label_app_kubernetes_io_name"]
    target_label  = "app"
  }

  rule {
    source_labels = ["app"]
    target_label  = "service_name"
  }

  rule {
    source_labels = ["app"]
    target_label  = "job"
  }
}

loki.source.file "pod_logs" {
  targets    = discovery.relabel.pod_logs.output
  forward_to = [loki.write.local.receiver]
}

loki.write "local" {
  endpoint {
    url = "http://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push"
  }
}
`;

  const alloy = new k8s.helm.v3.Chart("alloy", {
    namespace: namespace,
    chart: "alloy",
    version: "0.10.1",
    fetchOpts: {
      repo: "https://grafana.github.io/helm-charts",
    },
    values: {
      alloy: {
        config: alloyConfig,
        // CRITICAL: Move these to the 'alloy' block for this chart version
        extraVolumes: [
          {
            name: "varlog",
            hostPath: { path: "/var/log" },
          },
        ],
        extraVolumeMounts: [
          {
            name: "varlog",
            mountPath: "/var/log",
            readOnly: true,
          },
        ],
      },
      rbac: {
        create: true,
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
