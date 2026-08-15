import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createMCPServer } from "../library/mcp-server";

export function configureKubernetesMcp(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "kubernetes-mcp";

  // A dedicated service account ensures cluster capabilities are tightly scoped 
  // to this workload rather than shared by the namespace's default account.
  const sa = new k8s.core.v1.ServiceAccount(`${name}-sa`, {
    metadata: {
      name,
      namespace,
    },
  }, { dependsOn: dependencies });

  // A custom ClusterRole limits the LLM's capabilities to read-only diagnostics 
  // and specific pod deletion/deployment patching (restarts).
  const clusterRole = new k8s.rbac.v1.ClusterRole(`${name}-role`, {
    metadata: {
      name: "kubernetes-mcp-role",
    },
    rules: [
      {
        apiGroups: [""],
        resources: ["pods", "pods/log", "services", "endpoints", "configmaps"],
        verbs: ["get", "list", "watch"],
      },
      {
        apiGroups: ["apps"],
        resources: ["deployments", "statefulsets", "replicasets", "daemonsets"],
        verbs: ["get", "list", "watch"],
      },
      // Granting delete permissions on pods allows the agent to force pod restarts.
      {
        apiGroups: [""],
        resources: ["pods"],
        verbs: ["delete"],
      },
      // Granting patch permissions on deployments allows rollout restarts.
      {
        apiGroups: ["apps"],
        resources: ["deployments"],
        verbs: ["patch"],
      },
    ],
  }, { dependsOn: dependencies });

  // Bind the dedicated ServiceAccount to the ClusterRole.
  new k8s.rbac.v1.ClusterRoleBinding(`${name}-binding`, {
    metadata: {
      name: "kubernetes-mcp-binding",
    },
    subjects: [{
      kind: "ServiceAccount",
      name: sa.metadata.name,
      namespace,
    }],
    roleRef: {
      kind: "ClusterRole",
      name: clusterRole.metadata.name,
      apiGroup: "rbac.authorization.k8s.io",
    },
  }, { dependsOn: [sa, clusterRole] });

  // Deploy the standard community Go-based Kubernetes MCP server.
  return createMCPServer({
    name,
    namespace,
    image: "ghcr.io/containers/kubernetes-mcp-server:latest",
    serviceAccountName: sa.metadata.name,
    containerPort: 8000,
    args: ["--port", "8000"],
    dependencies: [sa],
  });
}
