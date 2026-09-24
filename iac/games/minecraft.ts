import { GamePlatform } from "../library/game-platform";

const minecraftPort = 25565;
// The image injects this into a Log4j XML attribute, so the JSON quotes need
// XML entities even though Log4j ultimately receives them as literal quotes.
const minecraftConsoleLogFormat = "{&quot;timestamp&quot;:&quot;%d{ISO8601}&quot;,&quot;thread&quot;:&quot;%t&quot;,&quot;level&quot;:&quot;%p&quot;,&quot;logger&quot;:&quot;%c&quot;,&quot;message&quot;:&quot;%enc{%m}{JSON}&quot;,&quot;exception&quot;:&quot;%enc{%throwable{full}}{JSON}&quot;}%n";

export function configureMinecraft(platform: GamePlatform) {
  const minecraft = platform.addServer("minecraft", {
    service: "minecraft",
    // Java 25 is required by Minecraft 26.3; VERSION remains explicit so a
    // normal rollout cannot silently change the server or world format.
    image: "itzg/minecraft-server:java25",
    endpoints: [{
      name: "minecraft",
      hostname: "minecraft.barpepe.party",
      containerPort: minecraftPort,
      protocol: "TCP",
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
      { name: "MEMORY", value: "6G" },
      { name: "VIEW_DISTANCE", value: "10" },
      { name: "SIMULATION_DISTANCE", value: "6" },
      { name: "USE_AIKAR_FLAGS", value: "true" },
      { name: "GENERATE_LOG4J2_CONFIG", value: "true" },
      { name: "LOG_CONSOLE_FORMAT", value: minecraftConsoleLogFormat },
    ],
		// Estimation for 3-5 players in a huge world with these settings:
		// { name: "VIEW_DISTANCE", value: "10" },
		// { name: "SIMULATION_DISTANCE", value: "6" },
    resources: {
      requests: { cpu: "1000m", memory: "7Gi" },
      limits: { cpu: "2500m", memory: "9Gi" },
    },
    healthCheck: {
      protocol: "tcp",
      endpoint: "minecraft",
      interval: "30s",
    },
  });

  return { minecraft };
}
