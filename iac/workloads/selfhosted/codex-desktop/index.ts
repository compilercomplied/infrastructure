import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp } from "../../../library/selfhosted-component";
import { configureTailscale } from "../../../platform/tailscale";
import { configureNamespaceSecurity } from "../security";

// Codex can outlive a crashing desktop session, so its process alone cannot establish GUI readiness.
const desktopHealthCommand = [
  "test -f /run/codex-desktop-installed",
  "pgrep -u abc -x ChatGPT >/dev/null",
  "pgrep -u abc -x xfce4-session >/dev/null",
  "pgrep -u abc -x xfwm4 >/dev/null",
].join(" && ");

export function configureCodexDesktop(operator: ReturnType<typeof configureTailscale>, issuer: k8s.apiextensions.CustomResource, kvmDevicePlugin: k8s.apps.v1.DaemonSet) {
  const name = "codex-desktop";
  const config = new pulumi.Config("codexDesktop");
  if (!config.getBoolean("enabled")) return;
  if (!operator) throw new Error("Codex desktop requires tailscale:enabled");
  const namespace = new k8s.core.v1.Namespace(name, { metadata: { name } });
  const security = configureNamespaceSecurity({
    namespace: namespace.metadata.name,
    dependencies: [namespace],
    namePrefix: `${name}-`,
    allowMonitoringScrape: false,
    allowCertManagerSolver: false,
  });
  const certificate = new k8s.apiextensions.CustomResource(`${name}-tls`, {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: { name: `${name}-tls`, namespace: namespace.metadata.name, annotations: { "pulumi.com/waitFor": "condition=Ready" } },
    spec: {
      secretName: `${name}-tls`,
      dnsNames: ["codex.gdario.dev"],
      // DNS validation keeps certificate issuance independent of public access to the desktop.
      issuerRef: { name: issuer.metadata.name, kind: "ClusterIssuer" },
    },
  }, { dependsOn: [namespace, issuer] });
  const files = Object.fromEntries(["init.sh", "session.sh", "reload-cert.sh"].map(file => [
    file, fs.readFileSync(path.join(__dirname, "scripts", file), "utf8"),
  ]));
  const scripts = new k8s.core.v1.ConfigMap(`${name}-scripts`, {
    metadata: { name: `${name}-scripts`, namespace: namespace.metadata.name },
    data: files,
  });
  const app = new SelfhostedApp(name, {
    namespace: namespace.metadata.name,
    image: "lscr.io/linuxserver/webtop:ubuntu-xfce@sha256:14fa1ceb750d4bf9e0880cb7e7b6a535f6f9210762a59ff992ef17e3375d48c0",
    // A single desktop must own the browser profile, keyring and worktrees on local-path storage.
    strategy: { type: "Recreate" },
    automountServiceAccountToken: false,
    // Device allocation grants QEMU access without exposing other host devices.
    nodeSelector: { "ci.gdario.dev/android-kvm": "true" },
    podSecurityContext: { supplementalGroups: [990] },
    // containerd's AppArmor mount denial breaks the nested bubblewrap sandboxes used by Glycin and Codex.
    containerSecurityContext: { privileged: false, appArmorProfile: { type: "Unconfined" } },
    endpoints: [{ name: "https", containerPort: 3001 }],
    settings: {
      config: {
        PUID: "1000", PGID: "1000", TZ: "Europe/Madrid",
        CUSTOM_USER: "gdario", TITLE: "Codex desktop",
        // X11 avoids the preview app's experimental native Wayland path.
        PIXELFLUX_WAYLAND: "false",
      },
      secrets: { PASSWORD: config.requireSecret("desktopPassword") },
    },
    volumes: [{ name: "home", mountPath: "/config", size: "30Gi", enableBackup: false }],
    additionalVolumes: [
      { name: "scripts", configMap: { name: scripts.metadata.name, defaultMode: 0o755 } },
      { name: "init", configMap: { name: scripts.metadata.name, defaultMode: 0o755, items: [{ key: "init.sh", path: "init.sh" }] } },
      { name: "shm", emptyDir: { medium: "Memory", sizeLimit: "1Gi" } },
      { name: "tls", secret: { secretName: `${name}-tls`, defaultMode: 0o600, items: [{ key: "tls.crt", path: "cert.pem" }, { key: "tls.key", path: "cert.key" }] } },
      { name: "services", configMap: { name: scripts.metadata.name, defaultMode: 0o755, items: [{ key: "reload-cert.sh", path: "reload-cert" }] } },
    ],
    additionalVolumeMounts: [
      { name: "scripts", mountPath: "/opt/codex-desktop", readOnly: true },
      { name: "init", mountPath: "/custom-cont-init.d", readOnly: true },
      { name: "shm", mountPath: "/dev/shm" },
      // Mount the directory, not subPaths, so kubelet projects certificate renewals into the running pod.
      { name: "tls", mountPath: "/config/ssl", readOnly: true },
      { name: "services", mountPath: "/custom-services.d", readOnly: true },
    ],
    podAnnotations: { "codex-desktop/scripts-checksum": crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex") },
    readinessProbe: {
      exec: { command: ["/bin/bash", "-c", desktopHealthCommand] },
      periodSeconds: 10,
    },
    // Webtop can serve its desktop even after a failed installer, so retry based on Codex itself.
    livenessProbe: {
      exec: { command: ["/bin/bash", "-c", desktopHealthCommand] },
      initialDelaySeconds: 600, periodSeconds: 30, failureThreshold: 5,
    },
    resources: {
      requests: { cpu: "500m", memory: "1Gi", "ephemeral-storage": "4Gi", "devic.es/kvm": "1" },
      limits: { cpu: "5", memory: "12Gi", "ephemeral-storage": "12Gi", "devic.es/kvm": "1" },
    },
    dependencies: [security.defaultDeny, scripts, certificate, kvmDevicePlugin],
  });

  // A Tailscale-class Service cannot be claimed by k3s ServiceLB or the public ingress controller.
  const tailnet = new k8s.core.v1.Service(`${name}-tailnet`, {
    metadata: {
      name: `${name}-tailnet`, namespace: namespace.metadata.name,
      annotations: { "tailscale.com/hostname": name },
    },
    spec: {
      type: "LoadBalancer", loadBalancerClass: "tailscale", allocateLoadBalancerNodePorts: false,
      selector: { app: name },
      ports: [{ name: "https", port: 443, targetPort: 3001 }],
    },
  }, { dependsOn: [app.service, operator.chart] });
  const tailnetPolicy = new k8s.networking.v1.NetworkPolicy(`${name}-allow-tailnet`, {
    metadata: { name: `${name}-allow-tailnet`, namespace: namespace.metadata.name },
    spec: {
      podSelector: { matchLabels: { app: name } }, policyTypes: ["Ingress"],
      ingress: [{
        from: [{
          namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "tailscale" } },
          podSelector: { matchLabels: {
            "tailscale.com/parent-resource": `${name}-tailnet`,
            "tailscale.com/parent-resource-ns": name,
            "tailscale.com/parent-resource-type": "svc",
          } },
        }],
        ports: [{ port: 3001, protocol: "TCP" }],
      }],
    },
  }, { dependsOn: [security.defaultDeny] });

  // Preserve the LAN source address so the default-deny exception cannot admit internet clients.
  const lan = new k8s.core.v1.Service(`${name}-lan`, {
    metadata: { name: `${name}-lan`, namespace: namespace.metadata.name },
    spec: {
      type: "NodePort", externalTrafficPolicy: "Local", selector: { app: name },
      ports: [{ name: "https", port: 443, targetPort: 3001, nodePort: 30443 }],
    },
  }, { dependsOn: [app.service] });
  const lanPolicy = new k8s.networking.v1.NetworkPolicy(`${name}-allow-lan`, {
    metadata: { name: `${name}-allow-lan`, namespace: namespace.metadata.name },
    spec: {
      podSelector: { matchLabels: { app: name } }, policyTypes: ["Ingress"],
      ingress: [{ from: [{ ipBlock: { cidr: "192.168.50.0/24" } }], ports: [{ port: 3001, protocol: "TCP" }] }],
    },
  }, { dependsOn: [security.defaultDeny] });
  // Resolve to the operator-assigned tailnet address without creating a public DNS record or ingress.
  const dnsRecord = {
    host: "codex.gdario.dev",
    address: tailnet.status.apply(status => {
      const address = status.loadBalancer?.ingress?.find(entry => entry.ip && !entry.ip.includes(":"))?.ip;
      if (!address) throw new Error("Codex desktop has no Tailscale IPv4 address");
      return address;
    }),
  };
  return { app, tailnet, tailnetPolicy, lan, lanPolicy, dnsRecord };
}
