import { GamePlatform } from "../library/game-platform";

const minecraftPort = 25565;

export function configureMinecraft(platform: GamePlatform) {
  const minecraft = platform.addServer("minecraft", {
    // Pin both the multi-architecture image manifest and the server release so a
    // normal rollout cannot change the Java runtime or mutate the world format.
    image: "itzg/minecraft-server@sha256:21b3d6bad32cc49ca15c8ceefcaffe94ac7fb6a53939fc7a5da066ec5dd0bc1d",
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
      { name: "VERSION", value: "1.21.8" },
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
