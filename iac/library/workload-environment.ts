import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface ManagedEnvironmentArgs {
  name: string;
  namespace: pulumi.Input<string>;
  config?: Record<string, pulumi.Input<string>>;
  secrets?: Record<string, pulumi.Input<string>>;
  dependencies?: pulumi.Resource[];
  parent?: pulumi.Resource;
  aliases?: pulumi.Alias[];
}

export interface ManagedEnvironment {
  configMap?: k8s.core.v1.ConfigMap;
  secret?: k8s.core.v1.Secret;
  envFrom: k8s.types.input.core.v1.EnvFromSource[];
}

export function createManagedEnvironment(args: ManagedEnvironmentArgs): ManagedEnvironment {
  const dependencies = args.dependencies ?? [];
  const envFrom: k8s.types.input.core.v1.EnvFromSource[] = [];
  let configMap: k8s.core.v1.ConfigMap | undefined;
  let secret: k8s.core.v1.Secret | undefined;

  if (args.config && Object.keys(args.config).length > 0) {
    configMap = new k8s.core.v1.ConfigMap(`${args.name}-config`, {
      metadata: {
        name: `${args.name}-config`,
        namespace: args.namespace,
      },
      data: args.config,
    }, { dependsOn: dependencies, parent: args.parent, aliases: args.aliases });

    envFrom.push({ configMapRef: { name: configMap.metadata.name } });
  }

  if (args.secrets && Object.keys(args.secrets).length > 0) {
    secret = new k8s.core.v1.Secret(`${args.name}-secrets`, {
      metadata: {
        name: `${args.name}-secrets`,
        namespace: args.namespace,
      },
      stringData: args.secrets,
    }, { dependsOn: dependencies, parent: args.parent, aliases: args.aliases });

    envFrom.push({ secretRef: { name: secret.metadata.name } });
  }

  return { configMap, secret, envFrom };
}
