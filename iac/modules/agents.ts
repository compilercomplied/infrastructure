import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configureAgents() {
    const config = new pulumi.Config("agents");

    const anthropicApiKey = config.requireSecret("anthropicApiKey");
    const githubToken = config.requireSecret("githubToken");
    const pulumiPassphrase = config.requireSecret("pulumiPassphrase");

    const namespace = new k8s.core.v1.Namespace("agents", {
        metadata: { name: "agents" }
    });

    const agentsSecret = new k8s.core.v1.Secret("dev-environment-secrets", {
        metadata: {
            name: "dev-environment-secrets",
            namespace: namespace.metadata.name,
        },
        stringData: {
            "ANTHROPIC_API_KEY": anthropicApiKey,
            "GITHUB_TOKEN": githubToken,
            "PULUMI_CONFIG_PASSPHRASE": pulumiPassphrase,
        },
    }, { dependsOn: namespace });

    return {
        namespace: namespace.metadata.name,
        secretName: agentsSecret.metadata.name,
    };
}
