import * as pulumi from "@pulumi/pulumi";

type AppAccessMode = "public" | "private" | "both";

export const tailnetEntryPoint = "tailnet";
export const tailnetTargetPort = 9443;
const publicIngressService = "traefik.kube-system.svc.cluster.local";
const privateIngressService = "traefik-tailnet.kube-system.svc.cluster.local";
const listeners = { public: "websecure", private: tailnetEntryPoint, both: `websecure,${tailnetEntryPoint}` };

export function loadAppAccess() {
  const config = new pulumi.Config("privateAccess");
  const enabled = config.getBoolean("enabled") ?? false;
  // Old stack settings must fail closed rather than silently changing app exposure or route approval.
  for (const key of ["grafanaPrivate", "dualHosts", "publishDualDns", "approveRoutes", "publishDns"]) {
    if (config.get(key) !== undefined) {
      throw new Error(`Replace privateAccess:${key} with privateAccess:enabled and privateAccess:apps`);
    }
  }
  const configured = config.getObject<unknown>("apps");
  const apps = configured === undefined ? {} : configured;
  if (apps === null || typeof apps !== "object" || Array.isArray(apps)) {
    throw new Error("privateAccess:apps must map hostnames to public, private, or both");
  }
  for (const [host, mode] of Object.entries(apps)) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host) || host.length > 253) {
      throw new Error(`Invalid hostname in privateAccess:apps: ${host}`);
    }
    if (!["public", "private", "both"].includes(mode as string)) {
      throw new Error(`Invalid access mode for ${host}: expected public, private, or both`);
    }
    if (mode !== "public" && !enabled) {
      throw new Error(`${host} requires privateAccess:enabled`);
    }
  }
  const modes = apps as Record<string, AppAccessMode>;
  const hosts = Object.keys(modes).sort();
  return {
    enabled,
    hosts,
    privateHosts: hosts.filter(host => modes[host] !== "public"),
    clusterDnsRewrites: hosts.map(host =>
      `rewrite stop name ${host} ${modes[host] === "public" ? publicIngressService : privateIngressService}`
    ),
    entryPoints: (host: string) => listeners[modes[host] ?? "public"],
  };
}

export const appAccess = loadAppAccess();
