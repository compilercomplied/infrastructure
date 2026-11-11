import * as k8s from "@pulumi/kubernetes";

/** Advertise one shared KVM allocation each for Hermes, the Forgejo runner and Codex desktop. */
export function configureKvmDevicePlugin() {
  const labels = { "app.kubernetes.io/name": "kvm-device-plugin" };
  return new k8s.apps.v1.DaemonSet("kvm-device-plugin", {
    metadata: { name: "kvm-device-plugin", namespace: "kube-system", labels },
    spec: {
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          nodeSelector: { "ci.gdario.dev/android-kvm": "true" },
          containers: [{
            name: "generic-device-plugin",
            image: "docker.io/squat/generic-device-plugin:0.2.0",
            args: ["--device", '{"name":"kvm","groups":[{"count":3,"paths":[{"path":"/dev/kvm"}]}]}'],
            securityContext: { allowPrivilegeEscalation: false },
            resources: { requests: { cpu: "10m", memory: "16Mi" }, limits: { cpu: "100m", memory: "64Mi" } },
            volumeMounts: [
              { name: "device-plugin", mountPath: "/var/lib/kubelet/device-plugins" },
              { name: "kvm", mountPath: "/dev/kvm", readOnly: true },
            ],
          }],
          volumes: [
            { name: "device-plugin", hostPath: { path: "/var/lib/kubelet/device-plugins", type: "Directory" } },
            { name: "kvm", hostPath: { path: "/dev/kvm", type: "CharDevice" } },
          ],
        },
      },
    },
  });
}
