import { monitoringCharts } from "../charts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as k8s from "@pulumi/kubernetes";
import { cachedHelmChart } from "../../../library/cached-helm-chart";
import * as pulumi from "@pulumi/pulumi";
import { alloyLabel } from "../tempo";

/**
 * Grafana Alloy Log Agent (Scraper/Collector)
 */
export function configureAlloy(
  namespace: pulumi.Input<string>,
  lokiService: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const BT = "\x60";
  const forgejoRegex = "\\s+\\[(?P<level_char>[TDIWEFC])\\]\\s+";
  const forgejoTemplate = "{{ `{{ if eq .level_char \"I\" }}info{{ else if eq .level_char \"W\" }}warning{{ else if eq .level_char \"E\" }}error{{ else if eq .level_char \"D\" }}debug{{ else if eq .level_char \"T\" }}trace{{ else if eq .level_char \"C\" }}critical{{ else if eq .level_char \"F\" }}critical{{ else }}info{{ end }}` }}";

  const logfmtRegex = "(?i)level=(?P<extracted_level>[a-zA-Z]+)";
  const logfmtTemplate = "{{ `{{ default .extracted_level .level }}` }}";

  const bracketRegex = "\\[(?P<bracket_level>(?i)trace|debug|info|warn|warning|error|fatal|critical)\\]";
  const bracketTemplate = "{{ `{{ default .bracket_level .level }}` }}";

  const lowercaseTemplate = "{{ `{{ ToLower .Value }}` }}";
  const storagePath = "/var/lib/grafana-alloy";

  const alloyConfig = pulumi.interpolate`
${readFileSync(join(__dirname, "opencode.alloy"), "utf8")}

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

  // Explicit mapping for loki-canary
  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    regex         = "^loki-canary-.*$"
    replacement   = "loki-canary"
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
  forward_to = [loki.process.pod_logs_parser.receiver]
}

// Extract and normalize log levels before ingestion into Loki.
// This resolves the "detected_level: unknown" issue in Grafana by mapping different log formats to standard Loki level labels.
loki.process "pod_logs_parser" {
  forward_to = [loki.write.local.receiver]

  // Parse and normalize the single-character levels used by Gitea/Forgejo (e.g. [I] -> info, [W] -> warning)
  stage.match {
    selector = "{app=~\\\"forgejo.*\\\"}"

    stage.regex {
      expression = ${BT}${forgejoRegex}${BT}
    }

    stage.template {
      source   = "level"
      template = ${BT}${forgejoTemplate}${BT}
    }

    stage.labels {
      values = {
        level = "level",
      }
    }
  }

  // Parse levels for other apps that use standard logfmt/JSON/bracket formats
  stage.match {
    selector = "{app!~\\\"forgejo.*\\\"}"

    // Try extracting level from JSON format first
    stage.json {
      expressions = { level = "level" }
    }

    // Try extracting level from logfmt format (e.g., level=info)
    stage.regex {
      expression = ${BT}${logfmtRegex}${BT}
    }

    stage.template {
      source   = "level"
      template = ${BT}${logfmtTemplate}${BT}
    }

    // Try extracting level from bracket format (e.g. [INFO])
    stage.regex {
      expression = ${BT}${bracketRegex}${BT}
    }

    stage.template {
      source   = "level"
      template = ${BT}${bracketTemplate}${BT}
    }

    // Normalize all levels to lowercase to ensure consistency in Grafana
    stage.template {
      source   = "level"
      template = ${BT}${lowercaseTemplate}${BT}
    }

    stage.labels {
      values = {
        level = "level",
      }
    }
  }
}

local.file_match "fail2ban" {
  path_targets = [{
    __path__ = "/var/log/host-fail2ban/fail2ban.log",
    job = "fail2ban",
    service_name = "fail2ban",
    host = "debian",
  }]
}

loki.source.file "fail2ban" {
  targets = local.file_match.fail2ban.targets
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
    ...cachedHelmChart(monitoringCharts["alloy"]),
    values: {
      alloy: {
        storagePath,
        resources: { requests: { cpu: "25m", memory: "384Mi" }, limits: { memory: "640Mi" } },
        mounts: {
          extra: [
            { name: "fail2ban-logs", mountPath: "/var/log/host-fail2ban", readOnly: true },
            { name: "alloy-storage", mountPath: storagePath },
          ],
        },
        extraPorts: [{ name: "otlp-http", port: 4318, targetPort: 4318, protocol: "TCP" }],
        configMap: {
          content: alloyConfig,
        },
      },
      rbac: {
        create: true,
      },
      controller: {
        type: "daemonset",
        volumes: {
          extra: [
            { name: "fail2ban-logs", hostPath: { path: "/var/log/fail2ban", type: "Directory" } },
            // A file offset belongs to the node that owns the log and must survive pod replacement.
            { name: "alloy-storage", hostPath: { path: storagePath, type: "DirectoryOrCreate" } },
          ],
        },
      },
    },
  },
    {
      dependsOn: dependencies,
    });

  new k8s.networking.v1.NetworkPolicy("alloy-opencode-ingress", {
    metadata: { name: "alloy-opencode-ingress", namespace },
    spec: {
      podSelector: { matchLabels: alloyLabel },
      policyTypes: ["Ingress"],
      ingress: [
        { from: [{ podSelector: {} }], ports: [{ protocol: "TCP", port: 12345 }] },
        {
          from: [{
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "agent-dev-environment" } },
            podSelector: { matchLabels: { app: "opencode-review" } },
          }],
          ports: [{ protocol: "TCP", port: 4318 }],
        },
      ],
    },
  });
  return alloy;
}
