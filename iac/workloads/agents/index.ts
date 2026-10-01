import * as k8s from "@pulumi/kubernetes";
import { configureTandoorMcp } from "./tandoor-mcp";
import { configureOutlineMcp } from "./outline-mcp";
import { configureHermesAgent } from "./hermes-agent";

export function configureAgentSidekicks(selfhosted: any, kvmDevicePlugin: k8s.apps.v1.DaemonSet) {
  const namespaceName = "agent-sidekicks";

  const tandoorMcp = configureTandoorMcp(namespaceName, [selfhosted.postgres, selfhosted.tandoor.deployment]);
  const outlineMcp = configureOutlineMcp(namespaceName, [selfhosted.outline.outline.deployment]);
  
  const hermes = configureHermesAgent(namespaceName, [
    selfhosted.postgres,
    tandoorMcp.service,
    outlineMcp.service,
    kvmDevicePlugin,
  ]);

  return {
    tandoorMcp,
    outlineMcp,
    hermes,
  };
}
