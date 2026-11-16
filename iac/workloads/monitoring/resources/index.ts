import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { resourceDashboard } from "./dashboard";

export function configureResourceDashboard(namespace: pulumi.Input<string>) {
  return new k8s.core.v1.ConfigMap("cluster-resources-dashboard", {
    metadata: { name: "cluster-resources-dashboard", namespace, labels: { grafana_dashboard: "1" } },
    data: { "cluster-resources.json": JSON.stringify(resourceDashboard) },
  });
}
