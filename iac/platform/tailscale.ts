import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configureTailscale() {
  const config = new pulumi.Config("tailscale");
  if (!config.getBoolean("enabled")) return;

  const clientId = config.require("clientId");
  if (!clientId.trim()) throw new Error("tailscale:clientId must not be empty");
  const clientSecret = config.requireSecret("clientSecret").apply(value => {
    if (!value.trim()) throw new Error("tailscale:clientSecret must not be empty");
    return value;
  });

  const namespace = new k8s.core.v1.Namespace("tailscale", {
    metadata: { name: "tailscale" },
  });
  const defaultDeny = new k8s.networking.v1.NetworkPolicy("tailscale-default-deny-ingress", {
    metadata: { name: "default-deny-ingress", namespace: namespace.metadata.name },
    spec: { podSelector: {}, policyTypes: ["Ingress"] },
  });
  const oauth = new k8s.core.v1.Secret("tailscale-operator-oauth", {
    metadata: { name: "operator-oauth", namespace: namespace.metadata.name },
    stringData: { client_id: clientId, client_secret: clientSecret },
  });
  const chart = new k8s.helm.v3.Chart("tailscale-operator", {
    namespace: namespace.metadata.name,
    chart: "tailscale-operator",
    // renovate: datasource=helm depName=tailscale-operator registryUrl=https://pkgs.tailscale.com/helmcharts
    version: "1.104.4",
    fetchOpts: { repo: "https://pkgs.tailscale.com/helmcharts" },
    values: {
      operatorConfig: { defaultTags: [config.get("operatorTag") ?? "tag:k8s-operator"] },
      proxyConfig: { defaultTags: "tag:kubernetes" },
      apiServerProxyConfig: { mode: "false", allowImpersonation: "false" },
      ingressClass: { enabled: false },
    },
  }, { dependsOn: [defaultDeny, oauth] });
  return { namespace: namespace.metadata.name, defaultDeny, chart };
}
