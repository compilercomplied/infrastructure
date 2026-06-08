import * as pulumi from "@pulumi/pulumi";
import { createMCPServer } from "../library/mcp-server";

export function configureTandoorMcp(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config("selfhosted");

  // The Tandoor API token is required by the MCP server to authenticate with the Tandoor recipes manager instance.
  // We retrieve this from a secure Pulumi stack configuration secret.
  const tandoorMcpToken = config.requireSecret("tandoorMcpToken");

  return createMCPServer({
    name: "tandoor-mcp",
    namespace,
    image: "ghcr.io/compilercomplied/tandoor-mcp:latest",
    containerPort: 8000,
    secrets: {
      "TANDOOR_API_TOKEN": tandoorMcpToken,
    },
    env: [
      {
        // We use the direct Kubernetes ClusterIP service DNS name for Tandoor recipes inside the cluster
        // to avoid routing external traffic and minimize latency.
        name: "TANDOOR_URL",
        value: "http://tandoor-recipes.selfhosted.svc.cluster.local:8080",
      },
      {
        // The public URL is configured so the MCP server can construct fully-qualified public hyperlinks
        // when returning recipes to users or agents.
        name: "TANDOOR_PUBLIC_URL",
        value: "https://recipes.gdario.dev",
      },
      {
        // Enable stateless HTTP mode globally in FastMCP as the stateless_http constructor argument is deprecated.
        name: "FASTMCP_STATELESS_HTTP",
        value: "true",
      },
    ],
    dependencies,
  });
}
