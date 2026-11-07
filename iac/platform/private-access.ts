import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as tailscale from "@pulumi/tailscale";
import { getDualAccessHosts, tailnetEntryPoint } from "../library/ingress";
import { authentikBaseUrl } from "../library/oidc-app";
import { grafanaIdentity } from "../workloads/monitoring/grafana/identity";
import { configurePrivateDns } from "./private-dns";
import { configureTailscale } from "./tailscale";

const connectorName = "homelab-pilot";
const pilotApps = [
  { name: "grafana", namespace: "monitoring", host: grafanaIdentity.host, service: "grafana" },
  { name: "authentik", namespace: "infrastructure", host: new URL(authentikBaseUrl).hostname, service: "authentik-server" },
];
const pilotHosts = pilotApps.map(app => app.host);

export function configurePrivateAccess(operator: ReturnType<typeof configureTailscale>) {
  const config = new pulumi.Config("privateAccess");
  const enabled = config.getBoolean("enabled");
  const publishDns = config.getBoolean("publishDns");
  const dualHosts = getDualAccessHosts();
  const publishDualDns = config.getBoolean("publishDualDns");
  if (dualHosts.length && !enabled) {
    throw new Error("privateAccess:dualHosts requires the private-access pilot");
  }
  if (new Set(dualHosts).size !== dualHosts.length || pilotHosts.some(host => dualHosts.includes(host))) {
    throw new Error("privateAccess:dualHosts must contain unique hosts outside the original pilot");
  }
  if (publishDualDns && !publishDns) {
    throw new Error("privateAccess:publishDualDns requires published pilot DNS");
  }
  const dnsHosts = publishDualDns ? [...pilotHosts, ...dualHosts] : pilotHosts;
  const grafanaPrivate = config.getBoolean("grafanaPrivate");
  if (grafanaPrivate && (!enabled || !publishDns)) {
    throw new Error("privateAccess:grafanaPrivate requires the pilot and published split DNS");
  }
  if (!enabled) return;
  if (!operator) throw new Error("privateAccess:enabled requires tailscale:enabled");

  const https = configurePrivateHttps();
  for (const app of pilotApps) {
    // The original Grafana ingress keeps ownership of the certificate when it moves to the private listener.
    if (grafanaPrivate && app.name === "grafana") continue;
    configurePrivateIngress(app, https);
  }
  const dns = configurePrivateDns(operator.namespace, operator.defaultDeny, connectorName, https.spec.clusterIP, dnsHosts);
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

  const approveRoutes = config.getBoolean("approveRoutes") ?? false;
  if (publishDns && !approveRoutes) {
    throw new Error("privateAccess:publishDns requires privateAccess:approveRoutes");
  }
  if (approveRoutes) {
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
    if (publishDns) {
      const dnsClientId = config.get("dnsClientId");
      const provider = new tailscale.Provider("private-access-dns-provider", {
        tailnet,
        ...(dnsClientId ? {
          oauthClientId: dnsClientId,
          oauthClientSecret: config.requireSecret("dnsClientSecret"),
          scopes: ["dns"],
        } : { apiKey: config.requireSecret("dnsApiKey") }),
      });
      for (const domain of dnsHosts) {
        new tailscale.DnsSplitNameservers(domain, {
          domain,
          nameservers: [dns.spec.clusterIP],
        }, { provider, dependsOn: [approval] });
      }
    }
  }
  return grafanaPrivate ? [tailnetEntryPoint] as const : undefined;
}

function configurePrivateIngress({ name, namespace, host, service }: typeof pilotApps[number], https: k8s.core.v1.Service) {
  const ingressName = `${name}-tailnet`;
  new k8s.networking.v1.Ingress(ingressName, {
    metadata: {
      name: ingressName,
      namespace,
      annotations: {
        "traefik.ingress.kubernetes.io/router.entrypoints": tailnetEntryPoint,
        "traefik.ingress.kubernetes.io/router.tls": "true",
        "traefik.ingress.kubernetes.io/router.middlewares": `${namespace}-${name}-rate-limit@kubernetescrd`,
      },
    },
    spec: {
      ingressClassName: "traefik",
      rules: [{
        host,
        http: {
          paths: [{
            path: "/",
            pathType: "Prefix",
            backend: { service: { name: service, port: { number: 80 } } },
          }],
        },
      }],
      // The existing ingress owns certificate issuance for this hostname.
      tls: [{ hosts: [host], secretName: `${name}-tls-cert` }],
    },
  }, { dependsOn: [https] });
}

function configurePrivateHttps() {
  const namespace = "kube-system";
  const chartConfig = new k8s.apiextensions.CustomResource("traefik-private-access", {
    apiVersion: "helm.cattle.io/v1",
    kind: "HelmChartConfig",
    metadata: { name: "traefik", namespace },
    spec: {
      // Keep the pilot listener separate from the ports used by Cloudflare and the LAN.
      valuesContent: JSON.stringify({
        ports: { [tailnetEntryPoint]: { port: 9443, expose: { default: false } } },
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
