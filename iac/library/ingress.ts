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
  middlewares?: pulumi.Input<string>[];
  dependencies?: pulumi.Resource[];
  /** Optional parent resource to establish the Pulumi resource hierarchy. */
  parent?: pulumi.Resource;
  /** Optional aliases to preserve resource URNs when migrating resources under component resources. */
  aliases?: pulumi.Alias[];
  /** Optional container port to authorize Ingress Controller (Traefik) network traffic. */
  targetPort?: number;
  /** Optional pod label selector to authorize Ingress Controller (Traefik) network traffic. */
  podSelector?: Record<string, string>;
}

export interface LetsEncryptIngressResult {
  ingress: k8s.networking.v1.Ingress;
  policy?: k8s.networking.v1.NetworkPolicy;
}

export function createLetsEncryptIngress(args: LetsEncryptIngressArgs): LetsEncryptIngressResult {
  const {
    name,
    namespace,
    host,
    serviceName,
    servicePort = 80,
    rateLimit = {},
    middlewares = [],
    dependencies = [],
    parent,
    aliases,
    targetPort,
    podSelector
  } = args;

  const extraAnnotations: Record<string, pulumi.Input<string>> = {};
  const ingressDependencies = [...dependencies];
  const middlewareRefs: pulumi.Input<string>[] = [];

  if (rateLimit !== false) {
    const rlAverage = rateLimit.average || 360;
    const rlBurst = rateLimit.burst || 720;
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
    }, { dependsOn: dependencies, parent, aliases });

    middlewareRefs.push(pulumi.interpolate`${namespace}-${middlewareName}@kubernetescrd`);
    ingressDependencies.push(middleware);
  }

  for (const mw of middlewares) {
    middlewareRefs.push(mw);
  }

  if (middlewareRefs.length > 0) {
    extraAnnotations["traefik.ingress.kubernetes.io/router.middlewares"] = pulumi.all(middlewareRefs).apply(refs => refs.join(","));
  }

  const ingress = new k8s.networking.v1.Ingress(`${name}-ingress`, {
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
  }, { dependsOn: ingressDependencies, parent, aliases });

  let policy: k8s.networking.v1.NetworkPolicy | undefined;

  // Integrating network policy definition directly with the ingress helper ensures that any exposed app
  // automatically permits ingress from the controller namespace, eliminating default-deny blocks.
  if (targetPort && podSelector) {
    policy = new k8s.networking.v1.NetworkPolicy(`${name}-allow-traefik`, {
      metadata: {
        name: `${name}-allow-traefik`,
        namespace,
      },
      spec: {
        podSelector: {
          matchLabels: podSelector,
        },
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: {
                    "kubernetes.io/metadata.name": "kube-system",
                  },
                },
              },
            ],
            ports: [{ port: targetPort }],
          },
        ],
        policyTypes: ["Ingress"],
      },
    }, { dependsOn: ingressDependencies, parent, aliases });
  }

  return { ingress, policy };
}
