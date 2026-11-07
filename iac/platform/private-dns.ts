import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configurePrivateDns(
  namespace: pulumi.Input<string>,
  defaultDeny: k8s.networking.v1.NetworkPolicy,
  connectorName: string,
  httpsAddress: pulumi.Input<string>,
  hosts: string[],
) {
  const name = "private-access-dns";
  const labels = { app: name };
  const dnsPort = 1053;
  const config = new k8s.core.v1.ConfigMap(name, {
    metadata: { name, namespace },
    data: {
      // Split DNS forwards only the pilot names, so this resolver can serve local records only.
      Corefile: pulumi.interpolate`.:${dnsPort} {
    errors
    ready
    reload
    hosts /dev/null {
        ${httpsAddress} ${hosts.join(" ")}
    }
}
`,
    },
  });
  const ingress = new k8s.networking.v1.NetworkPolicy(`${name}-allow-connector`, {
    metadata: { name: `${name}-allow-connector`, namespace },
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ["Ingress"],
      ingress: [{
        from: [{ podSelector: { matchLabels: {
          "tailscale.com/parent-resource-type": "connector",
          "tailscale.com/parent-resource": connectorName,
        } } }],
        ports: [{ port: dnsPort, protocol: "TCP" }, { port: dnsPort, protocol: "UDP" }],
      }],
    },
  }, { dependsOn: [defaultDeny] });

  const deployment = new k8s.apps.v1.Deployment(name, {
    metadata: { name, namespace },
    spec: {
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          containers: [{
            name: "coredns",
            image: "coredns/coredns:1.14.4",
            args: ["-conf", "/etc/coredns/Corefile"],
            readinessProbe: { httpGet: { path: "/ready", port: 8181 } },
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 65532,
              allowPrivilegeEscalation: false,
              // The upstream binary carries this file capability and cannot start without it in the bounding set.
              capabilities: { drop: ["ALL"], add: ["NET_BIND_SERVICE"] },
            },
            volumeMounts: [{ name: "config", mountPath: "/etc/coredns", readOnly: true }],
          }],
          volumes: [{ name: "config", configMap: { name: config.metadata.name } }],
        },
      },
    },
  }, { dependsOn: [ingress] });

  return new k8s.core.v1.Service(name, {
    metadata: { name, namespace },
    spec: {
      type: "ClusterIP",
      selector: labels,
      ports: [
        { name: "dns-tcp", port: 53, targetPort: dnsPort, protocol: "TCP" },
        { name: "dns-udp", port: 53, targetPort: dnsPort, protocol: "UDP" },
      ],
    },
  }, { dependsOn: [deployment] });
}
