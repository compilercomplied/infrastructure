import { GamePlatform } from "../../library/game-platform";

const minecraftPort = 25565;
// The image injects this into a Log4j XML attribute, so the JSON quotes need
// XML entities even though Log4j ultimately receives them as literal quotes.
const minecraftConsoleLogFormat = "{&quot;timestamp&quot;:&quot;%d{ISO8601}&quot;,&quot;thread&quot;:&quot;%t&quot;,&quot;level&quot;:&quot;%p&quot;,&quot;logger&quot;:&quot;%c&quot;,&quot;message&quot;:&quot;%enc{%m}{JSON}&quot;,&quot;exception&quot;:&quot;%enc{%throwable{full}}{JSON}&quot;}%n";

export function configureMinecraft(platform: GamePlatform) {
  const minecraft = platform.addServer("minecraft", {
    service: "minecraft",
    // Java 25 is required by Minecraft 26.3; VERSION remains explicit so a
    // normal rollout cannot silently change the server or world format.
    image: "itzg/minecraft-server@sha256:46cfd0bcbd9bbd16900a765fcdd5d6f57bc0cf3471c383ad96f87e84998d93e8",
    endpoints: [{
      name: "minecraft",
      hostname: "minecraft.barpepe.party",
      containerPort: minecraftPort,
      protocol: "TCP",
    }, {
      name: "map",
      containerPort: 8100,
      protocol: "TCP",
      exposeOnLan: false,
    }],
    httpIngresses: [{
      name: "minecraft-map",
      host: "minecraft-map.barpepe.party",
      endpoint: "map",
    }],
    storage: [{
      name: "world",
      mounts: [{ mountPath: "/data" }],
      size: "30Gi",
      storageClassName: "local-path",
    }],
    env: [
      { name: "EULA", value: "TRUE" },
      // Keep membership on the backed-up world volume and manage it with RCON;
      // a static IaC list would overwrite player changes on later rollouts.
      { name: "ENABLE_WHITELIST", value: "true" },
      // Fabric keeps gameplay changes reproducible for every player; these
      // server-side optimizations improve tick stability without changing play.
      { name: "TYPE", value: "FABRIC" },
      { name: "VERSION", value: "26.3" },
      { name: "MODRINTH_PROJECTS", value: "fabric-api\nlithium\nferrite-core\nbluemap:SX74rxzP" },
      { name: "MODRINTH_DOWNLOAD_DEPENDENCIES", value: "required" },
      { name: "MEMORY", value: "6G" },
      { name: "VIEW_DISTANCE", value: "10" },
      { name: "SIMULATION_DISTANCE", value: "6" },
      { name: "USE_AIKAR_FLAGS", value: "true" },
      { name: "GENERATE_LOG4J2_CONFIG", value: "true" },
      { name: "LOG_CONSOLE_FORMAT", value: minecraftConsoleLogFormat },
    ],

    // BlueMap's resource licence acknowledgement and render budget must survive pod recreation;
    // one renderer leaves CPU capacity for the latency-sensitive Minecraft server.
    initContainers: [{
      name: "configure-bluemap",
      image: "docker.io/library/busybox@sha256:b7f3d86d6e84fc17718c48bcde1450807faa2d56704205c697b4bd5df7b9e29f",
      command: ["sh", "-c", "set -eu\nrm -f -- /data/mods/squaremap-fabric-mc26.3-1.4.0.jar\nmkdir -p /data/config/bluemap\nprintf '%s\\n' 'accept-download: true' 'render-thread-count: 1' > /data/config/bluemap/core.conf\nchown -R 1000:1000 /data/config/bluemap"],
      volumeMounts: [{ name: "world", mountPath: "/data" }],
      resources: { requests: { cpu: "1m", memory: "4Mi" }, limits: { cpu: "10m", memory: "16Mi" } },
    }],
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
