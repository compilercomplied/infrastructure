import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as tailscale from "@pulumi/tailscale";
import { appAccess, tailnetEntryPoint, tailnetTargetPort } from "../library/app-access";
import { configurePrivateDns, PrivateDnsRecord } from "./private-dns";
import { configureTailscale } from "./tailscale";

const connectorName = "homelab-pilot";

export function configurePrivateAccess(operator: ReturnType<typeof configureTailscale>, additionalRecords: PrivateDnsRecord[] = []) {
  const config = new pulumi.Config("privateAccess");
  if (!appAccess.enabled) {
    if (additionalRecords.length) throw new Error("Private endpoint records require privateAccess:enabled");
    return;
  }
  if (!operator) throw new Error("privateAccess:enabled requires tailscale:enabled");

  const { privateHosts } = appAccess;
  const additionalHosts = additionalRecords.map(record => record.host);
  if (new Set(additionalHosts).size !== additionalHosts.length || additionalHosts.some(host => appAccess.hosts.includes(host))) {
    throw new Error("Private endpoint records must have unique hosts outside privateAccess:apps");
  }
  const dnsHosts = [...privateHosts, ...additionalHosts];

  const https = configurePrivateHttps();
  const dns = configurePrivateDns(operator.namespace, operator.defaultDeny, connectorName, https.spec.clusterIP, privateHosts, additionalRecords);
  const routes = [pulumi.interpolate`${https.spec.clusterIP}/32`, pulumi.interpolate`${dns.spec.clusterIP}/32`];
  const connectorDefinition = operator.chart.getResource(
    "apiextensions.k8s.io/v1/CustomResourceDefinition", "connectors.tailscale.com"
  );
  const connector = new k8s.apiextensions.CustomResource(connectorName, {
    apiVersion: "tailscale.com/v1alpha1",
    kind: "Connector",
    metadata: { name: connectorName },
    spec: {
      hostname: connectorName,
      subnetRouter: { advertiseRoutes: routes },
    },
  }, { dependsOn: [connectorDefinition, https, dns] });

  const operatorConfig = new pulumi.Config("tailscale");
  const tailnet = config.get("tailnet") ?? "-";
  const routeProvider = new tailscale.Provider("private-access-route-provider", {
    tailnet,
    oauthClientId: operatorConfig.require("clientId"),
    oauthClientSecret: operatorConfig.requireSecret("clientSecret"),
    scopes: ["devices:routes"],
  });
  const approval = new tailscale.DeviceSubnetRoutes("private-access-routes", {
    deviceId: config.require("connectorDeviceId"),
    routes,
  }, { provider: routeProvider, dependsOn: [connector] });
  const dnsClientId = config.get("dnsClientId");
  const provider = new tailscale.Provider("private-access-dns-provider", {
    tailnet,
    ...(dnsClientId ? {
      oauthClientId: dnsClientId,
      oauthClientSecret: config.requireSecret("dnsClientSecret"),
      scopes: ["dns"],
    } : { apiKey: config.requireSecret("dnsApiKey") }),
  });
  const dnsRecords = dnsHosts.map(domain => new tailscale.DnsSplitNameservers(domain, {
    domain,
    nameservers: [dns.spec.clusterIP],
  }, { provider, dependsOn: [approval] }));
  return { https, dns, connector, dnsRecords };
}

function configurePrivateHttps() {
  const namespace = "kube-system";
  const chartConfig = new k8s.apiextensions.CustomResource("traefik-private-access", {
    apiVersion: "helm.cattle.io/v1",
    kind: "HelmChartConfig",
    metadata: { name: "traefik", namespace },
    spec: {
      // Keep the private listener separate from the ports used by Cloudflare and the LAN.
      valuesContent: JSON.stringify({
        ports: { [tailnetEntryPoint]: { port: tailnetTargetPort, expose: { default: false } } },
      }),
    },
  });
  return new k8s.core.v1.Service("traefik-tailnet", {
    metadata: { name: "traefik-tailnet", namespace },
    spec: {
      type: "ClusterIP",
      selector: {
        "app.kubernetes.io/name": "traefik",
        "app.kubernetes.io/instance": "traefik-kube-system",
      },
      ports: [{ name: "https", port: 443, targetPort: tailnetEntryPoint }],
    },
  }, { dependsOn: [chartConfig] });
}
