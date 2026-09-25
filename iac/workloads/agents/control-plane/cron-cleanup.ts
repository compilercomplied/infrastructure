import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function createCleanupJob(namespace: pulumi.Input<string>) {
    const sa = new k8s.core.v1.ServiceAccount("agent-cleaner-sa", {
        metadata: { namespace, name: "agent-cleaner" }
    });

    const role = new k8s.rbac.v1.Role("agent-cleaner-role", {
        metadata: { namespace, name: "agent-cleaner" },
        rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["list", "delete"] }],
    });

    new k8s.rbac.v1.RoleBinding("agent-cleaner-rb", {
        metadata: { namespace },
        subjects: [{ kind: "ServiceAccount", name: sa.metadata.name, namespace }],
        roleRef: { kind: "Role", name: role.metadata.name, apiGroup: "rbac.authorization.k8s.io" },
    });

    return new k8s.batch.v1.CronJob("agent-cleanup", {
        metadata: { namespace, name: "agent-cleanup" },
        spec: {
            schedule: "0 0 * * *",
            jobTemplate: {
                spec: {
                    template: {
                        spec: {
                            serviceAccountName: sa.metadata.name,
                            containers: [{
                                name: "kubectl",
                                image: "bitnami/kubectl:latest",
                                command: ["/bin/sh", "-c"],
                                args: ["kubectl delete pods --field-selector=status.phase=Succeeded --ignore-not-found=true && kubectl delete pods --field-selector=status.phase=Failed --ignore-not-found=true"],
                            }],
                            restartPolicy: "OnFailure",
                        },
                    },
                },
            },
        },
    });
}
