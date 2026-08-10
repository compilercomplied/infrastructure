import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createMCPServer } from "../library/mcp-server";

export function configureForgejoMcp(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "forgejo-mcp";

  // Deploy the Gitea MCP server using a standard node base image.
  // We co-locate the pod on the same node as Forgejo using pod affinity
  // to allow concurrent mounting of the RWO persistent volume claim.
  return createMCPServer({
    name,
    namespace,
    image: "node:24-alpine",
    containerPort: 8000,
    // We fetch the generated access token from Gitea's volume before launching
    // the native Streamable HTTP endpoint for gitea-mcp.
    command: [
      "/bin/sh",
      "-c",
      "export GITEA_ACCESS_TOKEN=$(cat /forgejo-data/gitea/hermes-token.txt) && npm i -g gitea-mcp && export PORT=8000 && exec node /usr/local/lib/node_modules/gitea-mcp/dist/streamableHttp.js",
    ],
    env: [
      {
        name: "GITEA_HOST",
        value: "http://forgejo.selfhosted.svc.cluster.local:80",
      },
    ],
    volumes: [
      {
        name: "forgejo-data",
        persistentVolumeClaim: {
          claimName: "forgejo-pvc",
        },
      },
    ],
    volumeMounts: [
      // Mount the Forgejo data volume read-only to retrieve the token file.
      {
        name: "forgejo-data",
        mountPath: "/forgejo-data",
        readOnly: true,
      },
    ],
    // Co-locate the MCP pod with Forgejo on the same node for RWO PVC compatibility.
    affinity: {
      podAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [
          {
            labelSelector: {
              matchExpressions: [
                {
                  key: "app",
                  operator: "In",
                  values: ["forgejo"],
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
