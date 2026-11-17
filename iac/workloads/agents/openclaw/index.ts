import { AgentIdentity, agentIdentitySettings } from "../../../library/agent-identity";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { SelfhostedApp } from "../../../library/selfhosted-component";

export function configureOpenClaw(namespace: pulumi.Input<string>, identity: AgentIdentity, dependencies: pulumi.Resource[] = []) {
  const agent = agentIdentitySettings(identity);
  const image = "ghcr.io/openclaw/openclaw:2026.11.4";
  const token = new random.RandomPassword("openclaw-gateway-token", { length: 48, special: false });
  const seed = new k8s.core.v1.ConfigMap("openclaw-seed", {
    metadata: { name: "openclaw-seed", namespace },
    data: {
      "openclaw.json": JSON.stringify({
        gateway: {
          mode: "local",
          bind: "lan",
          port: 18789,
          auth: { mode: "token" },
          controlUi: { allowedOrigins: ["https://openclaw.gdario.dev"] },
        },
        agents: {
          defaults: {
            workspace: "/home/node/.openclaw/workspace",
            model: { primary: "openai/gpt-6-astra" },
            maxConcurrent: 1,
            subagents: { maxConcurrent: 1 },
          },
        },
        plugins: { entries: { codex: { enabled: true } } },
        memory: { search: { enabled: false } },
        browser: { enabled: false },
        session: { maintenance: { mode: "enforce", maxDiskBytes: "1gb", highWaterBytes: "800mb" } },
        update: { checkOnStart: false, auto: { enabled: false } },
      }, null, 2),
    },
  });

  const app = new SelfhostedApp("openclaw", {
    namespace,
    image,
    // The gateway's LAN bind listens on IPv4 only; IPv6 endpoints cause proxy 502s.
    ipFamilyPolicy: "SingleStack",
    ipFamilies: ["IPv4"],
    args: ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "18789"],
    strategy: { type: "Recreate" },
    endpoints: [{
      name: "http",
      containerPort: 18789,
      ingress: { name: "openclaw", host: "openclaw.gdario.dev" },
      healthCheck: { protocol: "http", path: "/startupz", servicePort: 18789 },
    }],
    settings: {
      config: {
        ...agent.config,
        HOME: "/home/node",
        OPENCLAW_HOME: "/home/node",
        OPENCLAW_STATE_DIR: "/home/node/.openclaw",
        OPENCLAW_CONFIG_PATH: "/home/node/.openclaw/openclaw.json",
        OPENCLAW_WORKSPACE_DIR: "/home/node/.openclaw/workspace",
        XDG_CACHE_HOME: "/tmp/cache",
        OPENCLAW_DISABLE_BONJOUR: "1",
        NODE_ENV: "production",
        TZ: "UTC",
      },
      secrets: { ...agent.secrets, OPENCLAW_GATEWAY_TOKEN: token.result },
    },
    // Mount the whole home so OAuth refresh state and private recovery captures
    // survive alongside sessions, rather than spilling onto the container layer.
    volumes: [{ name: "data", mountPath: "/home/node", size: "5Gi" }],
    additionalVolumes: [
      { name: "seed", configMap: { name: seed.metadata.name } },
      { name: "tmp", emptyDir: { sizeLimit: "256Mi" } },
    ],
    additionalVolumeMounts: [{ name: "tmp", mountPath: "/tmp", subPath: "runtime" }],
    podSecurityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
    containerSecurityContext: { readOnlyRootFilesystem: true },
    initContainers: [{
      name: "seed-config",
      image,
      command: ["node", "-e", `
        const fs = require('node:fs');
        // fsGroup makes volume roots group-writable; OpenClaw rejects those as
        // temp ancestors. Mount a private, app-owned child as the runtime /tmp.
        fs.mkdirSync('/tmp/runtime', { recursive: true, mode: 0o700 });
        fs.chmodSync('/tmp/runtime', 0o700);
        fs.mkdirSync('/home/node/.openclaw', { recursive: true, mode: 0o700 });
        // OAuth login updates this file; preserve it after the initial seed.
        try {
          fs.copyFileSync('/seed/openclaw.json', '/home/node/.openclaw/openclaw.json', fs.constants.COPYFILE_EXCL);
          fs.chmodSync('/home/node/.openclaw/openclaw.json', 0o600);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        // OpenClaw rejects forwarded requests with proxy_attribution_required
        // unless it trusts the proxy source, even with token authentication.
        // Traefik pod IPs change, so use the stable pod CIDR declared in
        // ansible/roles/cluster/templates/k3s-config.yaml.j2. The existing ingress
        // policy limits pod access to kube-system. Update the persisted config
        // because reseeding it would overwrite OAuth-managed settings.
        const configPath = '/home/node/.openclaw/openclaw.json';
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.gateway ??= {};
        config.gateway.trustedProxies = ['10.42.0.0/16'];
        // Tailscale SNAT leaves only trusted pod addresses in X-Forwarded-For.
        // Traefik strips client-supplied X-Real-IP and rebuilds it from its peer,
        // so this fallback preserves attribution when OpenClaw skips that chain.
        config.gateway.allowRealIpFallback = true;
        fs.writeFileSync(configPath + '.tmp', JSON.stringify(config, null, 2), { mode: 0o600 });
        fs.renameSync(configPath + '.tmp', configPath);
      `],
      securityContext: { readOnlyRootFilesystem: true },
      volumeMounts: [
        { name: "data", mountPath: "/home/node" },
        { name: "seed", mountPath: "/seed", readOnly: true },
        { name: "tmp", mountPath: "/tmp" },
      ],
      resources: {
        requests: { cpu: "50m", memory: "32Mi" },
        limits: { cpu: "250m", memory: "128Mi" },
      },
    }],
    readinessProbe: {
      httpGet: { path: "/startupz", port: 18789 },
      initialDelaySeconds: 10,
      periodSeconds: 10,
      timeoutSeconds: 5,
    },
    livenessProbe: {
      httpGet: { path: "/healthz", port: 18789 },
      initialDelaySeconds: 300,
      periodSeconds: 30,
      timeoutSeconds: 5,
    },
    // Reserve upstream's minimum; allow extra memory headroom for the personal
    // assistant without sizing for local model builds.
    resources: {
      requests: { cpu: "1", memory: "1Gi" },
      limits: { cpu: "2", memory: "3Gi" },
    },
    dependencies: [...dependencies, seed],
  });

  return app;
}
