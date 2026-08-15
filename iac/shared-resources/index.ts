import * as k8s from "@pulumi/kubernetes";
import { configureNamespaceSecurity } from "../selfhosted/security";

export function configureSharedResources() {
  const namespace = new k8s.core.v1.Namespace("shared-resources", {
    metadata: { name: "shared-resources" }
  });

  const namespaceName = namespace.metadata.name;

  const security = configureNamespaceSecurity({
    namespace: namespaceName,
    dependencies: [namespace],
    namePrefix: "shared-resources-",
  });

  // Pre-emptive bridge NetworkPolicy allowing other namespaces to connect 
  // to future databases in shared-resources during the migration.
  const allowCrossNamespaceTraffic = new k8s.networking.v1.NetworkPolicy("shared-resources-allow-cross-ns", {
    metadata: {
      name: "allow-cross-ns-ingress",
      namespace: namespaceName,
    },
    spec: {
      podSelector: {}, // Matches all pods in shared-resources
      ingress: [
        {
          from: [
            { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "selfhosted" } } },
            { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "infrastructure" } } },
            { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "forgejo" } } },
            { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "agents-control-plane" } } },
            { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "agent-sidekicks" } } },
          ],
        },
      ],
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: [security.defaultDeny] });

  return {
    namespace: namespaceName,
    security,
    allowCrossNamespaceTraffic,
  };
}
