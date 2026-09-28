import * as pulumi from "@pulumi/pulumi";
import { GamePlatform } from "../../library/game-platform";

const valheimGamePort = 2456;
const valheimQueryPort = 2457;
const valheimStatusPort = 8080;
const config = new pulumi.Config("selfhosted");
const valheimServerPassword = config.requireSecret("valheimServerPassword");

export function configureValheim(platform: GamePlatform) {
  const valheim = platform.addServer("valheim", {
    service: "valheim",
    // SteamCMD runs inside this image and updates the dedicated server at runtime.
    image: "ghcr.io/lloesche/valheim-server:latest",
    endpoints: [
      {
        name: "game",
        hostname: "valheim.barpepe.party",
        containerPort: valheimGamePort,
        servicePort: valheimGamePort,
        protocol: "UDP",
      },
      {
        name: "query",
        containerPort: valheimQueryPort,
        servicePort: valheimQueryPort,
        protocol: "UDP",
      },
    ],
    storage: [{
      name: "data",
      mounts: [
        { mountPath: "/config", subPath: "config" },
        { mountPath: "/opt/valheim", subPath: "server" },
      ],
      size: "20Gi",
      storageClassName: "local-path",
    }],
    env: [
      { name: "SERVER_NAME", value: "barpepe-Valheim" },
      { name: "WORLD_NAME", value: "barpepe" },
      { name: "SERVER_PUBLIC", value: "true" },
      { name: "SERVER_PORT", value: String(valheimGamePort) },
      { name: "CROSSPLAY", value: "false" },
      { name: "STATUS_HTTP", value: "true" },
      { name: "STATUS_HTTP_PORT", value: String(valheimStatusPort) },
      { name: "UPDATE_CRON", value: "0 */6 * * *" },
      { name: "BACKUPS_IDLE_GRACE_PERIOD", value: "3600" },
      { name: "VALHEIM_PLUS", value: "false" },
      { name: "BEPINEX", value: "true" },
    ],
    secrets: {
      SERVER_PASS: valheimServerPassword,
    },
    resources: {
      requests: { cpu: "250m", memory: "5Gi" },
      limits: { cpu: "3000m", memory: "8Gi" },
    },
    readinessProbe: {
      exec: {
        command: [
          "/usr/local/bin/valheim-status",
          "--host", "127.0.0.1",
          // The image's status client queries the dedicated server port; the
          // separate query endpoint times out even after the server is ready.
          "--port", String(valheimGamePort),
          "--timeout-is-error",
        ],
      },
      initialDelaySeconds: 120,
      periodSeconds: 30,
      timeoutSeconds: 10,
      failureThreshold: 6,
    },
    livenessProbe: {
      httpGet: { path: "/status.json", port: valheimStatusPort },
      initialDelaySeconds: 180,
      periodSeconds: 30,
      timeoutSeconds: 5,
      failureThreshold: 6,
    },

    containerSecurityContext: {
      capabilities: { add: ["SYS_NICE"] },
    },
  });

  return { valheim };
}
