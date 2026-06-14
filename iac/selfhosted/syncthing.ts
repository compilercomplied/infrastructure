import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createSelfhostedApp } from "../library/selfhosted-app";
import { createBackupJob } from "../maintenance/backup";

// Syncthing Deployment & Services Configuration.
// This sets up a future-proof personal sync service for Obsidian and other vaults.
export function configureSyncthing(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "syncthing";

  // Create ForwardAuth middleware custom resource targeting the Authentik outpost endpoint.
  // This interceptor blocks unauthenticated requests at the ingress layer.
  const authMiddleware = new k8s.apiextensions.CustomResource(`${name}-auth-middleware`, {
    apiVersion: "traefik.io/v1alpha1",
    kind: "Middleware",
    metadata: {
      name: `${name}-auth`,
      namespace,
    },
    spec: {
      forwardAuth: {
        address: "http://authentik-server.selfhosted.svc.cluster.local/outpost.goauthentik.io/auth/traefik",
        trustForwardHeader: true,
        authResponseHeaders: [
          "X-Authentik-Username",
          "X-Authentik-Groups",
          "X-Authentik-Email",
          "X-Authentik-Name",
          "X-Authentik-Uid",
          "Authorization",
        ],
      },
    },
  }, { dependsOn: dependencies });

  // Provision the application using the self-hosted application helper.
  // The local GUI credentials inside Syncthing will be disabled since access
  // is secured centrally via Authentik.
  const app = createSelfhostedApp({
    name,
    namespace,
    image: "syncthing/syncthing:1.27.8",
    containerPort: 8384,
    exposeType: "public",
    host: "syncthing.gdario.dev",
    env: [
      { name: "PUID", value: "1000" },
      { name: "PGID", value: "1000" },
    ],
    volumes: [
      {
        name: "syncthing-data",
        mountPath: "/var/syncthing",
        size: "2Gi",
        pvcName: "syncthing-data-pvc",
      },
    ],
    middlewares: [pulumi.interpolate`${namespace}-${authMiddleware.metadata.name}@kubernetescrd`],
    dependencies: [...dependencies, authMiddleware],
  });

  // Expose the sync protocol ports (22000 TCP and UDP) using a LoadBalancer service
  // to allow direct client connections over the physical network interface.
  // This enables high-speed, direct syncing on mobile/desktop without relay overhead.
  const syncService = new k8s.core.v1.Service(`${name}-sync`, {
    metadata: {
      name: `${name}-sync`,
      namespace,
    },
    spec: {
      type: "LoadBalancer",
      ports: [
        { port: 22000, targetPort: 22000, protocol: "TCP", name: "sync-tcp" },
        { port: 22000, targetPort: 22000, protocol: "UDP", name: "sync-udp" },
      ],
      selector: { app: name },
    },
  }, { dependsOn: app.deployment });

  // Restic PVC backup configuration to secure Syncthing's persistent directory.
  const filesBackup = createBackupJob({
    appName: name,
    namespace,
    source: {
      type: "pvc",
      pvcName: "syncthing-data-pvc",
      mountPath: "/var/syncthing",
    },
    dependencies: [...dependencies, app.deployment],
  });

  return {
    ...app,
    syncService,
    filesBackup,
  };
}
