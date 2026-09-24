import { GamePlatform } from "../library/game-platform";

const minecraftPort = 25565;

export function configureMinecraft(platform: GamePlatform) {
  const minecraft = platform.addServer("minecraft", {
    // Java 25 is required by Minecraft 26.3; VERSION remains explicit so a
    // normal rollout cannot silently change the server or world format.
    image: "itzg/minecraft-server:java25",
    endpoints: [{
      name: "minecraft",
      containerPort: minecraftPort,
      protocol: "TCP",
      exposeOnLan: true,
    }],
    stateVolume: {
      name: "world",
      mountPath: "/data",
      size: "30Gi",
      storageClassName: "local-path",
      enableBackup: true,
    },
    env: [
      { name: "EULA", value: "TRUE" },
      // Keep membership on the backed-up world volume and manage it with RCON;
      // a static IaC list would overwrite player changes on later rollouts.
      { name: "ENABLE_WHITELIST", value: "true" },
      { name: "VERSION", value: "26.3" },
      { name: "MEMORY", value: "4G" },
      { name: "VIEW_DISTANCE", value: "10" },
      { name: "SIMULATION_DISTANCE", value: "6" },
      { name: "USE_AIKAR_FLAGS", value: "true" },
    ],
    // Temporary cap for the current two-core node; restore the exploration CPU
    // allocation after the new CPU is installed and the node is validated.
    resources: {
      requests: { cpu: "250m", memory: "5Gi" },
      limits: { cpu: "750m", memory: "6Gi" },
    },
    healthCheck: {
      protocol: "tcp",
      endpoint: "minecraft",
      interval: "30s",
    },
  });

  return { minecraft };
}
