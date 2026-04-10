import { createNamespaces } from "./namespaces";
import { createAgentsSecrets } from "./secrets";
import { createOrchestratorRbac } from "./rbac";
import { createCleanupJob } from "./cron-cleanup";

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
