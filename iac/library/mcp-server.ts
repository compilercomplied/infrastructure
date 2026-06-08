import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface MCPServerArgs {
  name: string;
  namespace: pulumi.Input<string>;
  image: string;
  containerPort?: number; // Defaults to 8000
  env?: k8s.types.input.core.v1.EnvVar[];
  secrets?: Record<string, pulumi.Input<string>>;
  dependencies?: pulumi.Resource[];
}

export interface MCPServerResult {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  secret?: k8s.core.v1.Secret;
}

// Configures standard Kubernetes resources for cluster-internal MCP servers.
// By default, MCP servers inside the cluster do not need ingress or public routes;
// they are exposed via a standard ClusterIP service for internal agents to consume.
export function createMCPServer(args: MCPServerArgs): MCPServerResult {
  const {
    name,
    namespace,
    image,
    containerPort = 8000,
    env = [],
    secrets,
    dependencies = [],
  } = args;

  let secretResource: k8s.core.v1.Secret | undefined;
  const envFrom: k8s.types.input.core.v1.EnvFromSource[] = [];

  // Exposing secrets directly as environment variables via envFrom simplifies configuration,
  // making all keys in the secret available in the container environment.
  if (secrets && Object.keys(secrets).length > 0) {
    secretResource = new k8s.core.v1.Secret(`${name}-secrets`, {
      metadata: {
        name: `${name}-secrets`,
        namespace,
      },
      stringData: secrets,
    }, { dependsOn: dependencies });

    envFrom.push({
      secretRef: {
        name: secretResource.metadata.name,
      },
    });
  }

  const deploymentDeps = [...dependencies];
  if (secretResource) {
    deploymentDeps.push(secretResource);
  }

  const deployment = new k8s.apps.v1.Deployment(name, {
    metadata: {
      name,
      namespace,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: { app: name },
      },
      template: {
        metadata: {
          labels: { app: name },
        },
        spec: {
          containers: [{
            name,
            image,
            ports: [{ containerPort, name: "http" }],
            envFrom,
            env,
          }],
        },
      },
    },
  }, { dependsOn: deploymentDeps });

  // Exposes the MCP server internally via a standard ClusterIP service.
  // ClusterIP ensures that other workloads (like Hermes-agent or clean-up cronjobs)
  // can address it at http://name.namespace.svc.cluster.local:port.
  const service = new k8s.core.v1.Service(name, {
    metadata: {
      name,
      namespace,
    },
    spec: {
      ports: [{ port: containerPort, targetPort: containerPort, protocol: "TCP", name: "http" }],
      selector: { app: name },
      type: "ClusterIP",
    },
  }, { dependsOn: deployment });

  return {
    secret: secretResource,
    deployment,
    service,
  };
}
