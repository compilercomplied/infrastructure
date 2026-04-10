import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function createOrchestratorRbac(
    controlPlaneNamespace: pulumi.Input<string>,
    agentsNamespace: pulumi.Input<string>,
    secretName: pulumi.Input<string>
) {
    const serviceAccount = new k8s.core.v1.ServiceAccount("agent-orchestrator-serviceaccount", {
        metadata: {
            namespace: controlPlaneNamespace,
            name: "agent-orchestrator-serviceaccount"
        },
    }, { protect: true });

    const role = new k8s.rbac.v1.Role("agents-manager-role", {
        metadata: {
            namespace: agentsNamespace,
            name: "agents-manager",
        },
        rules: [
            {
                apiGroups: [""],
                resources: ["pods", "pods/log"],
                verbs: ["create", "list", "watch", "delete", "get"],
            },
            {
                apiGroups: [""],
                resources: ["secrets"],
                resourceNames: [secretName],
                verbs: ["get"],
            },
        ],
    });

    new k8s.rbac.v1.RoleBinding("agents-manager-rb", {
        metadata: {
            namespace: agentsNamespace,
            name: "agents-manager-binding",
        },
        subjects: [{
            kind: "ServiceAccount",
            name: serviceAccount.metadata.name,
            namespace: controlPlaneNamespace,
        }],
        roleRef: {
            kind: "Role",
            name: role.metadata.name,
            apiGroup: "rbac.authorization.k8s.io",
        },
    });

    return { serviceAccount };
}
