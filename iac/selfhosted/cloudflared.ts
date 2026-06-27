import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configureCloudflared(
    namespace: pulumi.Input<string>,
    token: pulumi.Output<string>,
    dependencies: pulumi.Resource[] = []
) {
    // Cloudflare Tunnel runs as a containerized agent inside the cluster. It establishes a secure,
    // outbound-only connection to Cloudflare's edge network, completely bypassing the need for 
    // home router port forwarding or public IP exposure.
    const secret = new k8s.core.v1.Secret("cloudflare-tunnel-token-secret", {
        metadata: {
            name: "cloudflare-tunnel-token-secret",
            namespace,
        },
        // We project the tunnel token into a secret to keep it out of container definitions,
        // preventing leaks in process lists or logs.
        stringData: {
            token: token,
        },
    }, { dependsOn: dependencies });

    const deployment = new k8s.apps.v1.Deployment("cloudflared", {
        metadata: {
            name: "cloudflared",
            namespace,
        },
        spec: {
            replicas: 1,
            selector: {
                matchLabels: {
                    app: "cloudflared",
                },
            },
            template: {
                metadata: {
                    labels: {
                        app: "cloudflared",
                    },
                },
                spec: {
                    containers: [
                        {
                            name: "cloudflared",
                            image: "cloudflare/cloudflared:latest",
                            args: [
                                "tunnel",
                                "--no-autoupdate",
                                "run",
                            ],
                            env: [
                                {
                                    // cloudflared looks for the TUNNEL_TOKEN environment variable by default
                                    // to authenticate and connect the agent daemon to Cloudflare's edge.
                                    name: "TUNNEL_TOKEN",
                                    valueFrom: {
                                        secretKeyRef: {
                                            name: secret.metadata.name,
                                            key: "token",
                                        },
                                    },
                                },
                            ],
                            resources: {
                                limits: {
                                    cpu: "500m",
                                    memory: "256Mi",
                                },
                                requests: {
                                    cpu: "100m",
                                    memory: "128Mi",
                                },
                            },
                        },
                    ],
                },
            },
        },
    }, { dependsOn: [secret] });

    return deployment;
}
