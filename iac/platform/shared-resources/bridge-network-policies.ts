import * as k8s from "@pulumi/kubernetes";

// Temporary bridge policies to allow cross-namespace communication during migration.
// These will be removed once all components have precise fine-grained policies.
export function configureBridgePolicies(targetNamespaces: string[], allowedFromNamespaces: string[]) {
  const policies = [];

  for (const ns of targetNamespaces) {
    policies.push(new k8s.networking.v1.NetworkPolicy(`bridge-allow-all-namespaces-${ns}`, {
      metadata: {
        name: "bridge-allow-all-namespaces",
        namespace: ns,
      },
      spec: {
        podSelector: {}, // Matches all pods in the namespace
        ingress: [
          {
            from: allowedFromNamespaces.map(fromNs => ({
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": fromNs } }
            }))
          }
        ],
        policyTypes: ["Ingress"],
      }
    }));
  }

  return policies;
}
