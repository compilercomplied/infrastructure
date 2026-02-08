import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configureTailscale() {
    const tailscaleConfig = new pulumi.Config("tailscale");

    // .require() will throw an error and crash the Pulumi program if the config value is missing
    const clientId = tailscaleConfig.require("clientId");
    const clientSecret = tailscaleConfig.requireSecret("clientSecret");

    const namespace = new k8s.core.v1.Namespace("tailscale", {
        metadata: { name: "tailscale" }
    });

    new k8s.helm.v3.Chart("tailscale-operator", {
        namespace: namespace.metadata.name,
        chart: "tailscale-operator",
        fetchOpts: {
            repo: "https://pkgs.tailscale.com/helmcharts",
        },
        values: {
            oauth: {
                clientId: clientId,
                clientSecret: clientSecret,
            },
            operatorConfig: {
								// This has to be the same tag used in the tailscale web UI.
                defaultTags: ["tag:kubernetes"],
            },
        },
    }, { dependsOn: namespace });

    return {
        namespace: namespace.metadata.name,
    };
}
