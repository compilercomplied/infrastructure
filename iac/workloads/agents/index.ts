import * as k8s from "@pulumi/kubernetes";
import { configureTandoorMcp } from "./tandoor-mcp";
import { configureOutlineMcp } from "./outline-mcp";
import { configureHermesAgent } from "./hermes-agent";
import { configureNodeDiagnostics } from "./node-diagnostics";

export function configureAgentSidekicks(selfhosted: any, kvmDevicePlugin: k8s.apps.v1.DaemonSet) {
  const namespaceName = "agent-sidekicks";

  const tandoorMcp = configureTandoorMcp(namespaceName, [selfhosted.postgres, selfhosted.tandoor.deployment]);
  const outlineMcp = configureOutlineMcp(namespaceName, [selfhosted.outline.outline.deployment]);
  const nodeDiagnostics = configureNodeDiagnostics(namespaceName, [kvmDevicePlugin]);
  
  const hermes = configureHermesAgent(namespaceName, [
    selfhosted.postgres,
    tandoorMcp.service,
    outlineMcp.service,
    nodeDiagnostics.service,
    kvmDevicePlugin,
  ]);

  return {
    tandoorMcp,
    outlineMcp,
    nodeDiagnostics,
    hermes,
  };
}
