import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { configureTandoorMcp } from "./tandoor-mcp";
import { configureOutlineMcp } from "./outline-mcp";
import { configureGrafanaMcp } from "./grafana-mcp";
import { configureKubernetesMcp } from "./kubernetes-mcp";
import { HermesAgent } from "../components/hermes/hermes-agent";

export function configureAgentSidekicks(selfhosted: any) {
  const namespaceName = "agent-sidekicks";

  const tandoorMcp = configureTandoorMcp(namespaceName, [selfhosted.postgres, selfhosted.tandoor.deployment]);
  const outlineMcp = configureOutlineMcp(namespaceName, [selfhosted.outline.outline.deployment]);
  const grafanaMcp = configureGrafanaMcp(namespaceName, [selfhosted.postgres]);
  const kubernetesMcp = configureKubernetesMcp(namespaceName, [selfhosted.postgres]);
  
  const hermes = new HermesAgent("hermes-agent", {
    namespace: namespaceName,
    dependencies: [
      selfhosted.postgres, 
 
      tandoorMcp.service, 
      grafanaMcp.service, 
      kubernetesMcp.service, 
      outlineMcp.service
    ],
  });

  return {
    tandoorMcp,
    outlineMcp,
    grafanaMcp,
    kubernetesMcp,
    hermes,
  };
}
