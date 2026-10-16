import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const collectorImage = "debian@sha256:2c037a04925515fdd6ea85ea14a682d0e79931f5e9f5d07b6dbfc6ba12f9e858";
const webImage = "busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";

const collectorScript = String.raw`#!/bin/sh
set -eu

output=/diagnostics

write_journal() {
  unit="$1"
  output_file="$2"
  : > "$output/$output_file.tmp"

  for directory in /host/var/log/journal /host/run/log/journal; do
    if [ -d "$directory" ]; then
      printf '%s\n' "--- $directory ---" >> "$output/$output_file.tmp"
      journalctl --directory="$directory" --no-pager --output=short-iso-precise \
        --since "24 hours ago" $unit 2>&1 >> "$output/$output_file.tmp" || true
    fi
  done

  tail -n 10000 "$output/$output_file.tmp" > "$output/$output_file" || true
  rm -f "$output/$output_file.tmp"
}

write_cgroup() {
  output_file="$1"
  : > "$output/$output_file.tmp"
  for file in memory.current memory.max memory.events memory.stat memory.pressure cpu.pressure io.pressure; do
    if [ -r "/host/sys/fs/cgroup/$file" ]; then
      printf '\n--- %s ---\n' "$file" >> "$output/$output_file.tmp"
      cat "/host/sys/fs/cgroup/$file" >> "$output/$output_file.tmp"
    fi
  done
  mv "$output/$output_file.tmp" "$output/$output_file"
}

while true; do
  write_journal "-k" kernel.log
  write_journal "-u kubelet.service" kubelet.log
  write_cgroup cgroup-root.log
  date --iso-8601=seconds > "$output/generated-at.txt"
  sleep 60
done
`;

export interface NodeDiagnostics {
  daemonSet: k8s.apps.v1.DaemonSet;
  service: k8s.core.v1.Service;
  hermesPolicy: k8s.networking.v1.NetworkPolicy;
}

export function configureNodeDiagnostics(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = [],
): NodeDiagnostics {
  const name = "node-diagnostics";
  const labels = { app: name };

  const script = new k8s.core.v1.ConfigMap(`${name}-script`, {
    metadata: { name: `${name}-script`, namespace },
    data: { "collect.sh": collectorScript },
  }, { dependsOn: dependencies });

  const daemonSet = new k8s.apps.v1.DaemonSet(name, {
    metadata: { name, namespace, labels },
    spec: {
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          // Diagnostics are meaningful only on nodes that can host the Android emulator.
          nodeSelector: { "ci.gdario.dev/android-kvm": "true" },
          automountServiceAccountToken: false,
          containers: [{
            name: "collector",
            image: collectorImage,
            command: ["/bin/sh", "-ec"],
            // Debian's base image intentionally omits journalctl. Installing it in the
            // ephemeral container filesystem keeps the host journal mount read-only.
            args: ["apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends systemd && exec /bin/sh /scripts/collect.sh"],
            securityContext: {
              runAsUser: 0,
              allowPrivilegeEscalation: false,
              capabilities: {
                // Journal files are generally readable only by root or systemd-journal.
                // Package installation also drops temporarily to Debian's _apt user
                // and moves its fetched files back into root-owned directories. These
                // capabilities apply only to the container's writable layer: every
                // host mount is read-only, so they cannot alter node state.
                drop: ["ALL"],
                add: ["CHOWN", "DAC_OVERRIDE", "DAC_READ_SEARCH", "FOWNER", "SETGID", "SETUID"],
              },
            },
            volumeMounts: [
              { name: "script", mountPath: "/scripts", readOnly: true },
              { name: "diagnostics", mountPath: "/diagnostics" },
              { name: "persistent-journal", mountPath: "/host/var/log", readOnly: true },
              { name: "volatile-journal", mountPath: "/host/run/log", readOnly: true },
              { name: "cgroup", mountPath: "/host/sys/fs/cgroup", readOnly: true },
            ],
          }, {
            name: "reader",
            image: webImage,
            command: ["httpd", "-f", "-p", "8080", "-h", "/diagnostics"],
            ports: [{ name: "http", containerPort: 8080 }],
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
            volumeMounts: [{ name: "diagnostics", mountPath: "/diagnostics", readOnly: true }],
          }],
          volumes: [
            { name: "script", configMap: { name: script.metadata.name, defaultMode: 0o555 } },
            { name: "diagnostics", emptyDir: {} },
            // Mount the existing parent directories so a node that uses only volatile
            // journald storage remains diagnosable without kubelet creating host paths.
            { name: "persistent-journal", hostPath: { path: "/var/log", type: "Directory" } },
            { name: "volatile-journal", hostPath: { path: "/run/log", type: "Directory" } },
            { name: "cgroup", hostPath: { path: "/sys/fs/cgroup", type: "Directory" } },
          ],
        },
      },
    },
  }, { dependsOn: [script, ...dependencies] });

  const service = new k8s.core.v1.Service(name, {
    metadata: { name, namespace },
    spec: {
      type: "ClusterIP",
      selector: labels,
      ports: [{ name: "http", port: 8080, targetPort: "http" }],
    },
  }, { dependsOn: daemonSet });

  const hermesPolicy = new k8s.networking.v1.NetworkPolicy(`${name}-allow-hermes`, {
    metadata: { name: `${name}-allow-hermes`, namespace },
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ["Ingress"],
      ingress: [{
        from: [{ podSelector: { matchLabels: { app: "hermes-agent" } } }],
        ports: [{ port: 8080, protocol: "TCP" }],
      }],
    },
  }, { dependsOn: daemonSet });

  return { daemonSet, service, hermesPolicy };
}
