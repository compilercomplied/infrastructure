import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp } from "../../library/selfhosted-component";

export function configureNtfy(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = [],
) {
  const config = new pulumi.Config("selfhosted");
  const adminPasswordHash = config.requireSecret("ntfyAdminPasswordHash");

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
    config: {
      NTFY_BASE_URL: "https://notifications.gdario.dev",
      NTFY_CACHE_FILE: "/var/lib/ntfy/cache.db",
      NTFY_AUTH_FILE: "/var/lib/ntfy/auth.db",
      NTFY_AUTH_DEFAULT_ACCESS: "deny-all",
      NTFY_ENABLE_LOGIN: "true",
      NTFY_REQUIRE_LOGIN: "true",
      NTFY_BEHIND_PROXY: "true",
      // iOS requires ntfy.sh to wake the app; message retrieval remains from
      // this instance, so the phone must be able to reach this public hostname.
      NTFY_UPSTREAM_BASE_URL: "https://ntfy.sh",
    },
    secrets: {
      NTFY_AUTH_USERS: pulumi.interpolate`gdario:${adminPasswordHash}:admin`,
    },
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
