import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface RateLimitConfig {
  average?: number;
  burst?: number;
  period?: string;
}

export interface LetsEncryptIngressArgs {
  name: string;
  namespace: pulumi.Input<string>;
  host: string;
  serviceName: pulumi.Input<string>;
  servicePort?: number;
  rateLimit?: RateLimitConfig | false;
  dependencies?: pulumi.Resource[];
}

export function createLetsEncryptIngress(args: LetsEncryptIngressArgs): k8s.networking.v1.Ingress {
  const {
    name,
    namespace,
    host,
    serviceName,
    servicePort = 80,
    rateLimit = {},
    dependencies = []
  } = args;

  const extraAnnotations: Record<string, pulumi.Input<string>> = {};
  const ingressDependencies = [...dependencies];

  if (rateLimit !== false) {
    const rlAverage = rateLimit.average || 360;
    const rlBurst = rateLimit.burst || 120;
    const rlPeriod = rateLimit.period || "1m";
    const middlewareName = `${name}-rate-limit`;

    const middleware = new k8s.apiextensions.CustomResource(middlewareName, {
      apiVersion: "traefik.io/v1alpha1",
      kind: "Middleware",
      metadata: {
        name: middlewareName,
        namespace,
      },
      spec: {
        rateLimit: {
          average: rlAverage,
          burst: rlBurst,
          period: rlPeriod,
        },
      },
    }, { dependsOn: dependencies });

    extraAnnotations["traefik.ingress.kubernetes.io/router.middlewares"] = pulumi.interpolate`${namespace}-${middlewareName}@kubernetescrd`;
    ingressDependencies.push(middleware);
  }

  return new k8s.networking.v1.Ingress(`${name}-ingress`, {
    metadata: {
      name: `${name}-ingress`,
      namespace,
      annotations: {
        "cert-manager.io/cluster-issuer": "letsencrypt-prod",
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
        "traefik.ingress.kubernetes.io/router.tls": "true",
        ...extraAnnotations,
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
  }, { dependsOn: ingressDependencies });
}
