import * as k8s from "@pulumi/kubernetes";
import { configureTandoorMcp } from "./tandoor-mcp";
import { configureOutlineMcp } from "./outline-mcp";
import { configureGrafanaMcp } from "./grafana-mcp";
import { configureKubernetesMcp } from "./kubernetes-mcp";
import { configureHermesAgent } from "./hermes-agent";

export function configureAgentSidekicks(selfhosted: any) {
  const namespaceName = "agent-sidekicks";

  const tandoorMcp = configureTandoorMcp(namespaceName, [selfhosted.postgres, selfhosted.tandoor.deployment]);
  const outlineMcp = configureOutlineMcp(namespaceName, [selfhosted.outline.outline.deployment]);
  const grafanaMcp = configureGrafanaMcp(namespaceName, [selfhosted.postgres]);
  const kubernetesMcp = configureKubernetesMcp(namespaceName, [selfhosted.postgres]);
  
  const hermes = configureHermesAgent(namespaceName, [
    selfhosted.postgres,
    tandoorMcp.service,
    grafanaMcp.service,
    kubernetesMcp.service,
    outlineMcp.service,
  ]);

  return {
    tandoorMcp,
    outlineMcp,
    grafanaMcp,
    kubernetesMcp,
    hermes,
  };
}
