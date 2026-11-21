import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { trafficSecurityDashboard } from "./dashboard";

export function configureTrafficSecurityDashboard(namespace: pulumi.Input<string>) {
  return new k8s.core.v1.ConfigMap("traffic-security-dashboard", {
    metadata: { name: "traffic-security-dashboard", namespace, labels: { grafana_dashboard: "1" } },
    data: { "traffic-security.json": JSON.stringify(trafficSecurityDashboard) },
  });
}
