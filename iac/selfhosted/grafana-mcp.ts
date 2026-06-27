import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as grafana from "@pulumiverse/grafana";
import { createMCPServer } from "../library/mcp-server";

export function configureGrafanaMcp(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config();
  const adminPassword = config.requireSecret("grafanaAdminPassword");

  const name = "grafana-mcp";

  // Create the Service Account and Token if not in bootstrapMode.
  const bootstrapMode = new pulumi.Config("selfhosted").getBoolean("bootstrapMode") || false;

  let secret: k8s.core.v1.Secret;
  if (!bootstrapMode) {
    // Create a custom Grafana provider using basic auth with the admin credentials.
    // Pulumi will connect remotely via the public ingress URL to provision the resources.
    const grafanaProvider = new grafana.Provider("grafana-provider", {
      url: "https://grafana.gdario.dev",
      auth: pulumi.interpolate`admin:${adminPassword}`,
      insecureSkipVerify: true,
    });

    // Create the Service Account with Admin role.
    const sa = new grafana.oss.ServiceAccount("hermes-agent-sa", {
      name: "hermes-agent",
      role: "Admin",
    }, { provider: grafanaProvider });

    // Generate a static token for the Service Account.
    const token = new grafana.oss.ServiceAccountToken("hermes-agent-token", {
      name: "hermes-mcp-token",
      serviceAccountId: sa.id,
    }, { provider: grafanaProvider });

    // Store the generated token key in a Kubernetes Secret for the MCP server to consume.
    secret = new k8s.core.v1.Secret("grafana-mcp-token", {
      metadata: {
        name: "grafana-mcp-token",
        namespace,
      },
      stringData: {
        "token": token.key,
      },
    }, { dependsOn: [token, ...dependencies] });
  } else {
    // In bootstrap mode, create a placeholder token secret to allow the pod to build
    secret = new k8s.core.v1.Secret("grafana-mcp-token", {
      metadata: {
        name: "grafana-mcp-token",
        namespace,
      },
      stringData: {
        "token": "bootstrap-dummy-token",
      },
    }, { dependsOn: dependencies });
  }

  // Expose Grafana MCP server internally in the selfhosted namespace.
  const mcpServer = createMCPServer({
    name,
    namespace,
    image: "grafana/mcp-grafana:latest",
    args: ["-t", "sse", "--address", ":8000"],
    containerPort: 8000,
    env: [
      {
        name: "GRAFANA_URL",
        value: "http://grafana.monitoring.svc.cluster.local:80",
      },
      {
        name: "GRAFANA_SERVICE_ACCOUNT_TOKEN",
        valueFrom: {
          secretKeyRef: {
            name: secret.metadata.name,
            key: "token",
          },
        },
      },
    ],
    dependencies: [secret],
  });

  return {
    deployment: mcpServer.deployment,
    service: mcpServer.service,
  };
}

