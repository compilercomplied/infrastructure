import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { createMCPServer } from "../library/mcp-server";

export function configureOutlineMcp(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "outline-mcp";
  const config = new pulumi.Config("selfhosted");
  
  // The Outline API token is required by the MCP server to authenticate with the Outline wiki instance.
  // The user should generate this inside Outline (Settings -> API Keys) and store it in Pulumi secrets.
  const outlineMcpToken = config.requireSecret("outlineMcpToken");

  // Since outline-mcp uses stdio, we must wrap it using supergateway to expose it over SSE.
  // We use a node base image with Python installed since mcp-outline is Python-based.
  return createMCPServer({
    name,
    namespace,
    // Python MCP SDK natively supports SSE transport via environment variables.
    image: "node:22-alpine",
    containerPort: 8000,
    command: ["/bin/sh", "-c"],
    args: [
      `apk add --no-cache python3 py3-pip && python3 -m venv /venv && /venv/bin/pip install mcp-outline && exec /venv/bin/python -m mcp_outline`
    ],
    env: [
      {
        name: "MCP_TRANSPORT",
        value: "sse",
      },
      {
        name: "MCP_PORT",
        value: "8000",
      },
      {
        name: "MCP_HOST",
        value: "0.0.0.0",
      },
      {
        name: "OUTLINE_API_KEY",
        value: outlineMcpToken,
      },
      {
        name: "OUTLINE_API_URL",
        value: "https://outline.gdario.dev/api",
      }
    ],
    dependencies,
  });
}
