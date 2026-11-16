import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { appAccess } from "../../library/app-access";

export function configureCoreDnsCustom(dependencies: pulumi.Resource[] = []) {
  // K3s owns the Deployment; reserve observed DNS memory without taking over its pod template.
  new k8s.apps.v1.DeploymentPatch("coredns-resources", {
    metadata: {
      name: "coredns",
      namespace: "kube-system",
      annotations: { "pulumi.com/patchForce": "true" },
    },
    spec: {
      template: {
        spec: {
          containers: [{ name: "coredns", resources: { requests: { memory: "128Mi" } } }],
        },
      },
    },
  }, { dependsOn: dependencies });

  // CoreDNS reloads mounted configuration, so DNS changes should preserve the ConfigMap's identity.
  const provider = new k8s.Provider("coredns-custom-config", { enableConfigMapMutable: true });
  return new k8s.core.v1.ConfigMap("coredns-custom", {
    metadata: {
      name: "coredns-custom",
      namespace: "kube-system",
    },
    data: {
      // Exact names keep DNS-01 challenges on public DNS while pods follow the app's listener policy.
      "rewrite.override": [
        ...appAccess.clusterDnsRewrites,
        "rewrite stop name pulp-ci.gdario.dev pulp.selfhosted.svc.cluster.local",
        "",
      ].join("\n"),
    },
  }, { provider, dependsOn: dependencies });
}
