import * as k8s from "@pulumi/kubernetes";
import { configureAuthentik } from "./authentik";
import { configureNamespaceSecurity } from "../../workloads/selfhosted/security";

export function configureInfrastructure() {
  const namespace = new k8s.core.v1.Namespace("infrastructure", {
    metadata: { name: "infrastructure" }
  });

  const namespaceName = namespace.metadata.name;

  // Keep this baseline owned by the namespace rather than a workload so retiring an
  // application cannot silently remove infrastructure's zero-trust protections.
  const security = configureNamespaceSecurity({
    namespace: namespaceName,
    dependencies: [namespace],
    namePrefix: "infrastructure-",
  });

  // DaemonSet to bump inotify limits on all nodes to fix fsnotify watcher errors
  // in applications like Grafana or Syncthing.
  const sysctlTuner = new k8s.apps.v1.DaemonSet("sysctl-tuner", {
    metadata: {
      name: "sysctl-tuner",
      namespace: "kube-system",
    },
    spec: {
      selector: {
        matchLabels: { app: "sysctl-tuner" },
      },
      template: {
        metadata: {
          labels: { app: "sysctl-tuner" },
        },
        spec: {
          hostNetwork: true,
          hostPID: true,
          containers: [
            {
              name: "sysctl-tuner",
              image: "alpine:latest",
              command: ["/bin/sh", "-c"],
              args: ["sysctl -w fs.inotify.max_user_watches=524288 && sysctl -w fs.inotify.max_user_instances=8192 && sleep infinity"],
              securityContext: {
                privileged: true,
              },
            },
          ],
        },
      },
    },
  });

  // The device plugin, runners, and diagnostics share this capability label. Keeping the
  // existing patch identity avoids removing it while retiring the Kata runtime.
  const androidKvmNodeLabel = new k8s.core.v1.NodePatch("android-kvm-node-label-debian", {
    metadata: {
      name: "debian",
      labels: {
        "ci.gdario.dev/android-kvm": "true",
      },
    },
  }, { aliases: [{ name: "kata-node-label-debian" }] });

  const authentik = configureAuthentik(namespaceName, []);

  return {
    namespace: namespaceName,
    security,
    androidKvmNodeLabel,
    sysctlTuner,
    authentik,
  };
}
