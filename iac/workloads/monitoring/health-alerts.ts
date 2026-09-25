import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configureHealthAlerts(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  return new k8s.apiextensions.CustomResource("selfhosted-health-alerts", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "PrometheusRule",
    metadata: {
      name: "selfhosted-health-alerts",
      namespace,
    },
    spec: {
      groups: [{
        name: "selfhosted-health",
        rules: [{
          alert: "SelfhostedHealthProbeFailed",
          expr: 'probe_success{job=~"health-.+"} == 0',
          for: "5m",
          labels: { severity: "warning" },
          annotations: {
            summary: "Health probe failed: {{ $labels.job }}",
            description: "{{ $labels.instance }} has failed its health probe for 5 minutes.",
          },
        }],
      }],
    },
  }, { dependsOn: dependencies });
}
