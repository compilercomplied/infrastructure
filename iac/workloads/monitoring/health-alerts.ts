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
        }, {
          alert: "BackupSnapshotStale",
          expr: 'time() - kube_cronjob_status_last_successful_time{cronjob=~".+-(pvc|postgres|mariadb)-.+"} > 129600',
          for: "30m",
          labels: { severity: "critical" },
          annotations: {
            summary: "Backup is stale: {{ $labels.namespace }}/{{ $labels.cronjob }}",
            description: "The backup CronJob has not completed successfully in more than 36 hours.",
          },
        }, {
          alert: "BackupNeverSucceeded",
          expr: 'kube_cronjob_info{cronjob=~".+-(pvc|postgres|mariadb)-.+"} unless on(namespace, cronjob) kube_cronjob_status_last_successful_time{cronjob=~".+-(pvc|postgres|mariadb)-.+"}',
          for: "36h",
          labels: { severity: "critical" },
          annotations: {
            summary: "Backup has never succeeded: {{ $labels.namespace }}/{{ $labels.cronjob }}",
            description: "The backup CronJob has existed for 36 hours without recording a successful run.",
          },
        }],
      }],
    },
  }, { dependsOn: dependencies });
}
