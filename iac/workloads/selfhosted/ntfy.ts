import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp } from "../../library/selfhosted-component";
import { ntfySettings } from "./ntfy-settings";

export function configureNtfy(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = [],
) {
  const app = new SelfhostedApp("ntfy", {
    namespace,
    image: "binwiederhier/ntfy:v2.28.0",
    args: ["serve"],
    endpoints: [{
      name: "http",
      servicePort: 80,
      containerPort: 80,
      ingress: { name: "ntfy", host: "notifications.gdario.dev" },
      healthCheck: { protocol: "http", path: "/v1/health" },
    }],
    settings: ntfySettings,
    volumes: [{
      name: "data",
      mountPath: "/var/lib/ntfy",
      size: "1Gi",
      pvcName: "ntfy-data-pvc",
    }],
    readinessProbe: {
      httpGet: { path: "/v1/health", port: 80 },
      initialDelaySeconds: 5,
      periodSeconds: 10,
      failureThreshold: 3,
    },
    livenessProbe: {
      httpGet: { path: "/v1/health", port: 80 },
      initialDelaySeconds: 15,
      periodSeconds: 30,
      failureThreshold: 3,
    },
    resources: {
      requests: { cpu: "25m", memory: "64Mi" },
      limits: { cpu: "250m", memory: "256Mi" },
    },
    dependencies,
  });

  return {
    deployment: app.deployment,
  };
}
