import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface NamespaceSecurityArgs {
  namespace: pulumi.Input<string>;
  dependencies?: pulumi.Resource[];
  namePrefix?: string;
  aliases?: {
    defaultDeny?: pulumi.Alias[];
    monitoring?: pulumi.Alias[];
    certManager?: pulumi.Alias[];
  };
}

/**
 * Configures the baseline network security policies for a namespace.
 * Establishes a zero-trust default-deny model while permitting required external
 * infrastructure integrations (e.g., Prometheus scraping, cert-manager solvers).
 */
export function configureNamespaceSecurity(args: NamespaceSecurityArgs) {
  const { namespace, dependencies = [], namePrefix = "", aliases = {} } = args;

  // Baseline zero-trust policy. Restricting lateral movement requires denying all ingress
  // by default, forcing components to explicitly declare their inbound permission rules.
  const defaultDeny = new k8s.networking.v1.NetworkPolicy(`${namePrefix}default-deny-ingress`, {
    metadata: {
      name: "default-deny-ingress",
      namespace,
    },
    spec: {
      podSelector: {}, // Empty matches all pods in the namespace
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: dependencies, aliases: aliases.defaultDeny });

  // Centralized monitoring scrapers (like Alloy or Prometheus in the monitoring namespace)
  // require ingress access to fetch metrics endpoints exposed by self-hosted applications.
  const allowMonitoringScrape = new k8s.networking.v1.NetworkPolicy(`${namePrefix}allow-monitoring-scrape`, {
    metadata: {
      name: "allow-monitoring-scrape",
      namespace,
    },
    spec: {
      podSelector: {}, // Matches all pods
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": "monitoring",
                },
              },
            },
          ],
        },
      ],
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: [defaultDeny], aliases: aliases.monitoring });

  // Cert-manager automatically spawns temporary HTTP-01 solver pods in the application's
  // namespace. Traefik must be allowed to reach these pods to solve ACME challenges.
  const allowCertManagerSolver = new k8s.networking.v1.NetworkPolicy(`${namePrefix}allow-cert-manager-solver`, {
    metadata: {
      name: "allow-cert-manager-solver",
      namespace,
    },
    spec: {
      podSelector: {
        matchLabels: {
          "acme.cert-manager.io/http01-solver": "true",
        },
      },
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": "kube-system",
                },
              },
            },
          ],
          ports: [{ port: 8089 }],
        },
      ],
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: [defaultDeny], aliases: aliases.certManager });

  return {
    defaultDeny,
    allowMonitoringScrape,
    allowCertManagerSolver,
  };
}
