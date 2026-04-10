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
  const alloyConfig = pulumi.interpolate`
discovery.kubernetes "pods" {
  role = "pod"
}

discovery.relabel "pod_logs" {
  targets = discovery.kubernetes.pods.targets

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

  // App/Service Identification (with fallbacks)
  rule {
    source_labels = ["__meta_kubernetes_pod_label_app"]
    target_label  = "app"
  }

  rule {
    source_labels = ["__meta_kubernetes_pod_label_app_kubernetes_io_name"]
    target_label  = "app"
  }

  // If app is still missing, fallback to container name
  rule {
    source_labels = ["app", "__meta_kubernetes_pod_container_name"]
    regex         = ";(.+)"
    replacement   = "$1"
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

// loki.source.kubernetes reads logs via the K8s API — no host mount or path construction needed.
loki.source.kubernetes "pod_logs" {
  targets    = discovery.relabel.pod_logs.output
  forward_to = [loki.write.local.receiver]
}

loki.write "local" {
  endpoint {
    url = "http://${lokiService}.${namespace}.svc.cluster.local:3100/loki/api/v1/push"
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
        configMap: {
          content: alloyConfig,
        },
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
      dependsOn: dependencies,
    });

  return alloy;
}
