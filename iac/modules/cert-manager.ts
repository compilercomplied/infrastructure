import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configureCertManager() {
    const config = new pulumi.Config("selfhosted");
    const acmeEmail = config.require("acmeEmail");

    // Define the cert-manager namespace
    const namespace = new k8s.core.v1.Namespace("cert-manager", {
        metadata: { name: "cert-manager" }
    });

    // Deploy cert-manager via the official Jetstack Helm chart
    const certManagerChart = new k8s.helm.v3.Chart("cert-manager", {
        namespace: namespace.metadata.name,
        chart: "cert-manager",
        version: "v1.14.4",
        fetchOpts: {
            repo: "https://charts.jetstack.io",
        },
        values: {
            installCRDs: true, // Crucial to register ClusterIssuer and Certificate CRDs
        },
    }, { dependsOn: namespace });

    // Configure Let's Encrypt Production ClusterIssuer using CustomResource
    const letsEncryptProd = new k8s.apiextensions.CustomResource("letsencrypt-prod", {
        apiVersion: "cert-manager.io/v1",
        kind: "ClusterIssuer",
        metadata: {
            name: "letsencrypt-prod",
        },
        spec: {
            acme: {
                server: "https://acme-v02.api.letsencrypt.org/directory",
                email: acmeEmail,
                privateKeySecretRef: {
                    name: "letsencrypt-prod-account-key",
                },
                solvers: [
                    {
                        http01: {
                            ingress: {
                                class: "traefik",
                            },
                        },
                    },
                ],
            },
        },
    }, { dependsOn: certManagerChart });

    return {
        namespace: namespace.metadata.name,
        certManagerChart,
        letsEncryptProd,
    };
}
