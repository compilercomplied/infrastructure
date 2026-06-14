import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as grafana from "@pulumiverse/grafana";

export function configureGrafanaMcp(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config();
  const adminPassword = config.requireSecret("grafanaAdminPassword");

  const name = "grafana-mcp";

  // Create a custom Grafana provider using basic auth with the admin credentials.
  // Pulumi will connect remotely via the public ingress URL to provision the resources.
  const grafanaProvider = new grafana.Provider("grafana-provider", {
    url: "https://grafana.gdario.dev",
    auth: pulumi.interpolate`admin:${adminPassword}`,
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
  const secret = new k8s.core.v1.Secret("grafana-mcp-token", {
    metadata: {
      name: "grafana-mcp-token",
      namespace,
    },
    stringData: {
      "token": token.key,
    },
  }, { dependsOn: [token, ...dependencies] });

  // Expose Grafana MCP server internally in the selfhosted namespace.
  const deployment = new k8s.apps.v1.Deployment(name, {
    metadata: {
      name,
      namespace,
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          containers: [{
            name: "grafana-mcp",
            image: "grafana/mcp-grafana:latest",
            args: ["-t", "sse", "--address", ":8000"],
            ports: [{ containerPort: 8000, name: "http" }],
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
          }],
        },
      },
    },
  }, { dependsOn: [secret] });

  const service = new k8s.core.v1.Service(name, {
    metadata: {
      name,
      namespace,
    },
    spec: {
      ports: [{ port: 8000, targetPort: 8000, protocol: "TCP", name: "http" }],
      selector: { app: name },
      type: "ClusterIP",
    },
  }, { dependsOn: deployment });

  return {
    deployment,
    service,
  };
}
