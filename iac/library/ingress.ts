import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface LetsEncryptIngressArgs {
  name: string;
  namespace: pulumi.Input<string>;
  host: string;
  serviceName: pulumi.Input<string>;
  servicePort?: number;
  dependencies?: pulumi.Resource[];
}

export function createLetsEncryptIngress(args: LetsEncryptIngressArgs): k8s.networking.v1.Ingress {
  const { name, namespace, host, serviceName, servicePort = 80, dependencies = [] } = args;

  return new k8s.networking.v1.Ingress(`${name}-ingress`, {
    metadata: {
      name: `${name}-ingress`,
      namespace,
      annotations: {
        "cert-manager.io/cluster-issuer": "letsencrypt-prod",
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
        "traefik.ingress.kubernetes.io/router.tls": "true",
      },
    },
    spec: {
      ingressClassName: "traefik",
      rules: [{
        host: host,
        http: {
          paths: [{
            path: "/",
            pathType: "Prefix",
            backend: {
              service: {
                name: serviceName,
                port: { number: servicePort },
              },
            },
          }],
        },
      }],
      tls: [{
        hosts: [host],
        secretName: `${name}-tls-cert`,
      }],
    },
  }, { dependsOn: dependencies });
}
