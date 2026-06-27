import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/**
 * Provisions a custom CoreDNS override ConfigMap in the kube-system namespace.
 * This instructs the cluster's internal DNS resolver to rewrite any queries ending
 * in .home.arpa to point to the Traefik LoadBalancer service, enabling local-only
 * domain routing over the VPN tunnel.
 */
export function configureCoreDnsCustom(dependencies: pulumi.Resource[] = []) {
  return new k8s.core.v1.ConfigMap("coredns-custom", {
    metadata: {
      name: "coredns-custom",
      namespace: "kube-system",
    },
    data: {
      // The rewrite.override key is automatically matched by the import statement in K3s CoreDNS config.
      // We rewrite exact hosts only to ensure that Let's Encrypt DNS-01 TXT validation queries
      // (_acme-challenge.*) bypass local routing and resolve via public DNS nameservers.
      "rewrite.override": `rewrite stop name auth.gdario.dev traefik.kube-system.svc.cluster.local
rewrite stop name recipes.gdario.dev traefik.kube-system.svc.cluster.local
rewrite stop name linkwarden.gdario.dev traefik.kube-system.svc.cluster.local
rewrite stop name grimmory.gdario.dev traefik.kube-system.svc.cluster.local
rewrite stop name syncthing.gdario.dev traefik.kube-system.svc.cluster.local
rewrite stop name grafana.gdario.dev traefik.kube-system.svc.cluster.local
rewrite stop name hermes.gdario.dev traefik.kube-system.svc.cluster.local
rewrite stop name hermes-api.gdario.dev traefik.kube-system.svc.cluster.local
`,
    },
  }, { dependsOn: dependencies });
}
