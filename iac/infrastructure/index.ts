import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { configureAuthentik } from "./authentik";
import { deployLitellm } from "../selfhosted/litellm";

export function configureInfrastructure() {
  // A dedicated namespace is created to isolate core infrastructure components
  // (like LiteLLM proxy) from general self-hosted services and user agents.
  const namespace = new k8s.core.v1.Namespace("infrastructure", {
    metadata: { name: "infrastructure" }
  });

  const namespaceName = namespace.metadata.name;

  const config = new pulumi.Config("selfhosted");

  const litellm = deployLitellm({
    namespace,
    config,
  });

  // Kata Containers Deployment (kata-deploy)
  // This Helm chart deploys a privileged DaemonSet that installs the Kata Containers runtime
  // onto the host nodes and configures k3s' containerd to use it. It also automatically creates
  // the `kata` RuntimeClass.
  //
  // NOTE: This approach was chosen to respect the "Zero ClickOps" rule and keep all cluster
  // configuration centralized in the IaC. If managing host-level binaries via DaemonSet becomes
  // problematic, consider migrating this setup to the `ansible-playbook` host setup directly
  // (installing kata packages and templating config.toml.tmpl via Ansible) and only keep the
  // RuntimeClass definition here.
  const kataDeploy = new k8s.helm.v3.Release("kata-deploy", {
    chart: "./infrastructure/kata-deploy",
    namespace: "kube-system",
    values: {
      k8sDistribution: "k3s",
      runtimeClasses: {
        createDefault: true,
      },
    },
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

  // Declaratively enforce the Kata Containers runtime node label on the worker node
  // so that node resets or re-initializations preserve the katacontainers.io/kata-runtime label.
  const kataNodeLabel = new k8s.core.v1.NodePatch("kata-node-label-debian", {
    metadata: {
      name: "debian",
      labels: {
        "katacontainers.io/kata-runtime": "true",
      },
    },
  }, { dependsOn: [kataDeploy] });

  const authentik = configureAuthentik(namespaceName, []);

  return {
    namespace: namespaceName,
    ...litellm,
    kataDeploy,
    kataNodeLabel,
    sysctlTuner,
    authentik,
  };
}
