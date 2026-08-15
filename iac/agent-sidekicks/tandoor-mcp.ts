import * as pulumi from "@pulumi/pulumi";
import { createMCPServer } from "../library/mcp-server";

export function configureTandoorMcp(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config("selfhosted");

  // The Tandoor API token is required by the MCP server to authenticate with the Tandoor recipes manager instance.
  const tandoorMcpToken = config.requireSecret("tandoorMcpToken");

  return createMCPServer({
    name: "tandoor-mcp",
    namespace,
    image: "ghcr.io/compilercomplied/tandoor-mcp:latest",
    containerPort: 8080, // The new Go-based MCP server exposes its SSE listener on 8080 instead of the old Python version's 8000.
    secrets: {
      "TANDOOR_API_TOKEN": tandoorMcpToken,
    },
    env: [
      {
        // Direct internal cluster URL is used to keep requests within the VPC/cluster network, avoiding egress and lowering latency.
        name: "TANDOOR_API_URL",
        value: "http://tandoor-recipes.selfhosted.svc.cluster.local:80",
      },
      {
        // Constructed public URLs are returned by the MCP to ensure client links resolve correctly externally.
        name: "TANDOOR_PUBLIC_URL",
        value: "https://recipes.gdario.dev",
      },
      {
        // JSON format is enabled for unified ingest into Loki and structured observability.
        name: "LOG_FORMAT",
        value: "json",
      },
      {
        // HTTP body logging is enabled to troubleshoot payload-level schema issues or failed LLM tool payloads.
        name: "LOG_HTTP_BODY",
        value: "true",
      },
    ],
    dependencies,
  });
}
