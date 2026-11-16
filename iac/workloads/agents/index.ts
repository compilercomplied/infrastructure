import { AgentIdentity } from "../../library/agent-identity";
import * as k8s from "@pulumi/kubernetes";
import { configureNamespaceSecurity } from "../selfhosted/security";
import { configureTandoorMcp } from "./tandoor-mcp";
import { configureOutlineMcp } from "./outline-mcp";
import { configureHermesAgent } from "./hermes-agent";
import { configureNodeDiagnostics } from "./node-diagnostics";
import { configureOpenClaw } from "./openclaw";

export function configureAgentSidekicks(selfhosted: any, kvmDevicePlugin: k8s.apps.v1.DaemonSet, identity: AgentIdentity) {
  const namespace = new k8s.core.v1.Namespace("agent-sidekicks", {
    metadata: { name: "agent-sidekicks" },
  });
  const namespaceName = namespace.metadata.name;
  const security = configureNamespaceSecurity({
    namespace: namespaceName,
    dependencies: [namespace],
    namePrefix: "agent-sidekicks-",
  });

  const openclaw = configureOpenClaw(namespaceName, [security.defaultDeny]);

  const tandoorMcp = configureTandoorMcp(namespaceName, [selfhosted.postgres, selfhosted.tandoor.deployment]);
  const outlineMcp = configureOutlineMcp(namespaceName, [selfhosted.outline.outline.deployment]);
  const nodeDiagnostics = configureNodeDiagnostics(namespaceName, [kvmDevicePlugin]);
  
  const hermes = configureHermesAgent(namespaceName, identity, [
    selfhosted.postgres,
    tandoorMcp.service,
    outlineMcp.service,
    nodeDiagnostics.service,
    kvmDevicePlugin,
  ]);

  return {
    namespace,
    security,
    tandoorMcp,
    outlineMcp,
    nodeDiagnostics,
    hermes,
    openclaw,
  };
}
