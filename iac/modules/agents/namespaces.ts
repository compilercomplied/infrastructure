import * as k8s from "@pulumi/kubernetes";

export function createNamespaces() {
    const agents = new k8s.core.v1.Namespace("agents", {
        metadata: { name: "agents" }
    }, { protect: true });

    const controlPlane = new k8s.core.v1.Namespace("agents-control-plane", {
        metadata: { name: "agents-control-plane" }
    }, { protect: true });

    return { agents, controlPlane };
}
