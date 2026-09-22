import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface PrivateServicePort {
  name: string;
  containerPort: number;
  servicePort?: number;
  protocol?: "TCP" | "UDP" | "SCTP";
}

export interface PrivateServiceArgs {
  name: string;
  namespace: pulumi.Input<string>;
  selector: Record<string, string>;
  ports: PrivateServicePort[];
  dependencies?: pulumi.Resource[];
  parent?: pulumi.Resource;
  aliases?: pulumi.Alias[];
  ipFamilyPolicy?: string;
  ipFamilies?: string[];
}

export function createPrivateService(args: PrivateServiceArgs): k8s.core.v1.Service {
  return new k8s.core.v1.Service(args.name, {
    metadata: {
      name: args.name,
      namespace: args.namespace,
      labels: args.selector,
    },
    spec: {
      ipFamilyPolicy: args.ipFamilyPolicy ?? "PreferDualStack",
      ipFamilies: args.ipFamilies ?? ["IPv4", "IPv6"],
      ports: args.ports.map(port => ({
        name: port.name,
        port: port.servicePort ?? port.containerPort,
        targetPort: port.containerPort,
        protocol: port.protocol ?? "TCP",
      })),
      selector: args.selector,
    },
  }, { dependsOn: args.dependencies, parent: args.parent, aliases: args.aliases });
}
