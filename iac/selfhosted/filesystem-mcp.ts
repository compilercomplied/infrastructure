import * as pulumi from "@pulumi/pulumi";
import { createMCPServer } from "../library/mcp-server";

export function configureFilesystemMcp(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "filesystem-mcp";

  // Deploy the official filesystem MCP server over SSE using supergateway.
  // We co-locate the pod on the same node as Syncthing using pod affinity
  // to ensure ReadWriteOnce persistent volume claims can be attached.
  return createMCPServer({
    name,
    namespace,
    image: "mcp/filesystem:latest",
    containerPort: 3000,
    // We override the command to wrap the stdio-only official server in supergateway.
    // This translates stdio JSON-RPC streams into an SSE server natively.
    command: [
      "npx",
      "-y",
      "supergateway",
      "--stdio",
      "node dist/index.js /obsidian-vaults",
      "--port",
      "3000",
    ],
    // Run as user 1000 to match Syncthing's GID/UID, avoiding permission errors on the PVC.
    securityContext: {
      runAsUser: 1000,
      runAsGroup: 1000,
    },
    volumes: [
      {
        name: "syncthing-data",
        persistentVolumeClaim: {
          claimName: "syncthing-data-pvc",
        },
      },
    ],
    volumeMounts: [
      // Scope the MCP server's access strictly to the obsidian-vaults subdirectory.
      {
        name: "syncthing-data",
        mountPath: "/obsidian-vaults",
        subPath: "obsidian-vaults",
      },
    ],
    // Co-locate the MCP pod with Syncthing on the same node for RWO PVC compatibility.
    affinity: {
      podAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [
          {
            labelSelector: {
              matchExpressions: [
                {
                  key: "app",
                  operator: "In",
                  values: ["syncthing"],
                },
              ],
            },
            topologyKey: "kubernetes.io/hostname",
          },
        ],
      },
    },
    dependencies,
  });
}
