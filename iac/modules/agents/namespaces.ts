import * as k8s from "@pulumi/kubernetes";
import { configureNamespaceSecurity } from "../../selfhosted/security";

export function createNamespaces() {
    const agents = new k8s.core.v1.Namespace("agents", {
        metadata: { name: "agents" }
    }, { protect: true });

    const controlPlane = new k8s.core.v1.Namespace("agents-control-plane", {
        metadata: { name: "agents-control-plane" }
    }, { protect: true });

    const agentSidekicks = new k8s.core.v1.Namespace("agent-sidekicks", {
        metadata: { name: "agent-sidekicks" }
    });

    const agentSandbox = new k8s.core.v1.Namespace("agent-sandbox", {
        metadata: { name: "agent-sandbox" }
    });

    configureNamespaceSecurity({
        namespace: agentSidekicks.metadata.name,
        dependencies: [agentSidekicks],
        namePrefix: "agent-sidekicks-",
    });

    configureNamespaceSecurity({
        namespace: agentSandbox.metadata.name,
        dependencies: [agentSandbox],
        namePrefix: "agent-sandbox-",
    });

    return { agents, controlPlane, agentSidekicks, agentSandbox };
}
