import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface WireguardArgs {
  namespace: pulumi.Input<string>;
  dependencies?: pulumi.Resource[];
}

/**
 * Deploys a headless WireGuard VPN server using the official linuxserver/wireguard image.
 * This configures the VPN tunnel in a 100% declarative, Zero ClickOps model,
 * generating server and client configs directly in code and exporting the client config as a stack output.
 */
export function configureWireguard(
  name: string,
  args: WireguardArgs,
  opts?: pulumi.ComponentResourceOptions
) {
  const { namespace, dependencies = [] } = args;

  const config = new pulumi.Config("selfhosted");
  const vpnServerPrivateKey = config.requireSecret("vpnServerPrivateKey");
  const vpnServerPublicKey = config.requireSecret("vpnServerPublicKey");
  const vpnClientPrivateKey = config.requireSecret("vpnClientPrivateKey");
  const vpnClientPublicKey = config.requireSecret("vpnClientPublicKey");

  // Construct the server's wg0.conf configuration.
  const serverConfig = pulumi.all([vpnServerPrivateKey, vpnClientPublicKey]).apply(([serverKey, clientKey]) => {
    return `[Interface]
Address = 10.8.0.1/24
ListenPort = 51820
PrivateKey = ${serverKey}
PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

[Peer]
PublicKey = ${clientKey}
AllowedIPs = 10.8.0.2/32
`;
  });

  // Construct the client's .conf profile.
  // In Phase 2, DNS will point to the cluster's CoreDNS service IP (10.43.0.10) to resolve *.home.arpa.
  const clientConfig = pulumi.all([vpnClientPrivateKey, vpnServerPublicKey]).apply(([clientKey, serverKey]) => {
    return `[Interface]
PrivateKey = ${clientKey}
Address = 10.8.0.2/24
DNS = 10.43.0.10

[Peer]
PublicKey = ${serverKey}
Endpoint = vpn.gdario.dev:51820
AllowedIPs = 10.8.0.0/24, 10.42.0.0/16, 10.43.0.0/16, 192.168.50.0/24
PersistentKeepalive = 25
`;
  });

  // Package the server configuration inside a Kubernetes Secret.
  const secret = new k8s.core.v1.Secret(`${name}-secrets`, {
    metadata: {
      name: `${name}-secrets`,
      namespace,
    },
    stringData: {
      "wg0.conf": serverConfig,
    },
  }, { dependsOn: dependencies });

  // emptyDir volume allows the container to write lock files and state files to its /config directory.
  const configVolume = { name: "config-dir", emptyDir: {} };
  const secretVolume = {
    name: "config-secret",
    secret: {
      secretName: secret.metadata.name,
      defaultMode: 0o600,
    },
  };

  // Deployment running headless linuxserver/wireguard.
  // Requires NET_ADMIN capability to create and manage the virtual network interface (wg0).
  const deployment = new k8s.apps.v1.Deployment(name, {
    metadata: {
      name,
      namespace,
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: {
          labels: { app: name },
        },
        spec: {
          // The initContainer copies the read-only configuration secret into the writeable emptyDir volume.
          initContainers: [{
            name: "copy-config",
            image: "lscr.io/linuxserver/wireguard:latest",
            command: ["/bin/sh", "-c", "cp /etc/wireguard-secret/wg0.conf /config/wg0.conf && chmod 600 /config/wg0.conf"],
            volumeMounts: [
              { name: "config-secret", mountPath: "/etc/wireguard-secret", readOnly: true },
              { name: "config-dir", mountPath: "/config" },
            ],
          }],
          containers: [{
            name: "wireguard",
            image: "lscr.io/linuxserver/wireguard:latest",
            ports: [
              { containerPort: 51820, name: "wireguard", protocol: "UDP" },
            ],
            securityContext: {
              capabilities: {
                add: ["NET_ADMIN", "SYS_MODULE"],
              },
            },
            env: [
              { name: "PUID", value: "1000" },
              { name: "PGID", value: "1000" },
              { name: "TZ", value: "Etc/UTC" },
            ],
            volumeMounts: [
              { name: "config-dir", mountPath: "/config" },
            ],
          }],
          volumes: [configVolume, secretVolume],
        },
      },
    },
  }, { dependsOn: [secret, ...dependencies] });

  // Expose UDP 51820 via a LoadBalancer service so the public IP / WAN IP can route
  // traffic directly into the WireGuard container.
  const service = new k8s.core.v1.Service(name, {
    metadata: {
      name,
      namespace,
    },
    spec: {
      type: "LoadBalancer",
      ports: [
        { port: 51820, targetPort: 51820, protocol: "UDP", name: "wireguard" },
      ],
      selector: { app: name },
    },
  }, { dependsOn: deployment });

  return {
    deployment,
    service,
    clientConfig,
  };
}
