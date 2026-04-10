import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function createAgentsSecrets(namespace: pulumi.Input<string>) {
    const config = new pulumi.Config("agents");
    
    return new k8s.core.v1.Secret("dev-environment-secrets", {
        metadata: {
            name: "dev-environment-secrets",
            namespace: namespace,
        },
        stringData: {
            "ANTHROPIC_API_KEY": config.requireSecret("anthropicApiKey"),
            "GITHUB_TOKEN": config.requireSecret("githubToken"),
            "PULUMI_CONFIG_PASSPHRASE": config.requireSecret("pulumiPassphrase"),
        },
    });
}
