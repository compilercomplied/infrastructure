import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export type IngressPeerSelector =
  | {
      podSelector: Record<string, string>;
      namespaceSelector?: Record<string, string>;
    }
  | {
      podSelector?: Record<string, string>;
      namespaceSelector: Record<string, string>;
    };

export type PeerIngressRule = IngressPeerSelector & {
  name?: string;
  port?: number;
};

export interface PeerIngressPolicyArgs {
  workloadName: string;
  namespace: pulumi.Input<string>;
  podSelector: Record<string, string>;
  containerPort: number;
  protocol?: "TCP" | "UDP" | "SCTP";
  rules?: PeerIngressRule[];
  dependencies?: pulumi.Resource[];
  parent?: pulumi.Resource;
  aliases?: pulumi.Alias[];
}

export function createPeerIngressPolicies(args: PeerIngressPolicyArgs): k8s.networking.v1.NetworkPolicy[] {
  const policies: k8s.networking.v1.NetworkPolicy[] = [];

  for (const rule of args.rules ?? []) {
    const clientName = rule.name ?? Object.values(rule.podSelector ?? {})[0];
    if (!clientName) {
      throw new Error(`Ingress rule for ${args.workloadName} requires a name or a non-empty pod selector.`);
    }

    const policyName = `${args.workloadName}-allow-${clientName}`;
    policies.push(new k8s.networking.v1.NetworkPolicy(policyName, {
      metadata: { name: policyName, namespace: args.namespace },
      spec: {
        podSelector: { matchLabels: args.podSelector },
        ingress: [{
          from: [{
            ...(rule.podSelector ? { podSelector: { matchLabels: rule.podSelector } } : {}),
            ...(rule.namespaceSelector ? { namespaceSelector: { matchLabels: rule.namespaceSelector } } : {}),
          }],
          ports: [{
            port: rule.port ?? args.containerPort,
            protocol: args.protocol,
          }],
        }],
        policyTypes: ["Ingress"],
      },
    }, { dependsOn: args.dependencies, parent: args.parent, aliases: args.aliases }));
  }

  return policies;
}
