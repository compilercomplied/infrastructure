import { createNamespaces } from "./control-plane/namespaces";
import { createAgentsSecrets } from "./control-plane/secrets";
import { createOrchestratorRbac } from "./control-plane/rbac";
import { createCleanupJob } from "./control-plane/cron-cleanup";

export function configureAgents() {
    const { agents, controlPlane } = createNamespaces();
    const secrets = createAgentsSecrets(agents.metadata.name);
    
    const { serviceAccount } = createOrchestratorRbac(
        controlPlane.metadata.name,
        agents.metadata.name,
        secrets.metadata.name
    );

    createCleanupJob(agents.metadata.name);

    return {
        namespace: agents.metadata.name,
        controlPlaneNamespace: controlPlane.metadata.name,
        orchestratorServiceAccount: serviceAccount.metadata.name,
    };
}
