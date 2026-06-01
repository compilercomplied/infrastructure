import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configureAuthentik(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config("selfhosted");
  const authentikSecretKey = config.requireSecret("authentikSecretKey");
  const authentikDbPassword = config.requireSecret("authentikDbPassword");
  const acmeEmail = config.requireSecret("acmeEmail");
  const authentikAdminPassword = config.requireSecret("authentikAdminPassword");

  const name = "authentik";
  const image = "ghcr.io/goauthentik/server:2026.5.2";

  // 1. Create PVCs for persistent customization storage (media and templates)
  const mediaPvc = new k8s.core.v1.PersistentVolumeClaim(`${name}-media-pvc`, {
    metadata: {
      name: `${name}-media-pvc`,
      namespace,
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "local-path",
      resources: {
        requests: {
          storage: "2Gi",
        },
      },
    },
  }, { dependsOn: dependencies });

  const templatesPvc = new k8s.core.v1.PersistentVolumeClaim(`${name}-templates-pvc`, {
    metadata: {
      name: `${name}-templates-pvc`,
      namespace,
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "local-path",
      resources: {
        requests: {
          storage: "2Gi",
        },
      },
    },
  }, { dependsOn: dependencies });

  // 2. Secret store for Authentik's security key and database connection
  const secrets = new k8s.core.v1.Secret(`${name}-secrets`, {
    metadata: {
      name: `${name}-secrets`,
      namespace,
    },
    stringData: {
      "AUTHENTIK_SECRET_KEY": authentikSecretKey,
      "AUTHENTIK_POSTGRESQL__PASSWORD": authentikDbPassword,
      "AUTHENTIK_BOOTSTRAP_PASSWORD": authentikAdminPassword,
      "AUTHENTIK_BOOTSTRAP_EMAIL": acmeEmail,
    },
  }, { dependsOn: dependencies });

  // 3. Redis Deployment & Service (required cache store)
  const redisName = `${name}-redis`;
  const redisDeployment = new k8s.apps.v1.Deployment(redisName, {
    metadata: {
      name: redisName,
      namespace,
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: redisName } },
      template: {
        metadata: { labels: { app: redisName } },
        spec: {
          containers: [{
            name: "redis",
            image: "redis:7-alpine",
            ports: [{ containerPort: 6379, name: "redis" }],
          }],
        },
      },
    },
  }, { dependsOn: dependencies });

  const redisService = new k8s.core.v1.Service(redisName, {
    metadata: {
      name: redisName,
      namespace,
    },
    spec: {
      ports: [{ port: 6379, targetPort: 6379, name: "redis" }],
      selector: { app: redisName },
    },
  }, { dependsOn: redisDeployment });

  // 4. Common Environment Variables for Server and Worker
  const commonEnv = [
    { name: "AUTHENTIK_REDIS__HOST", value: redisService.metadata.name },
    { name: "AUTHENTIK_POSTGRESQL__HOST", value: "shared-postgres.selfhosted.svc.cluster.local" },
    { name: "AUTHENTIK_POSTGRESQL__USER", value: "authentik" },
    { name: "AUTHENTIK_POSTGRESQL__NAME", value: "authentik" },
    { name: "AUTHENTIK_POSTGRESQL__PORT", value: "5432" },
    { name: "AUTHENTIK_ERROR_REPORTING__ENABLED", value: "false" },
    {
      name: "AUTHENTIK_SECRET_KEY",
      valueFrom: {
        secretKeyRef: {
          name: secrets.metadata.name,
          key: "AUTHENTIK_SECRET_KEY",
        },
      },
    },
    {
      name: "AUTHENTIK_POSTGRESQL__PASSWORD",
      valueFrom: {
        secretKeyRef: {
          name: secrets.metadata.name,
          key: "AUTHENTIK_POSTGRESQL__PASSWORD",
        },
      },
    },
    {
      name: "AUTHENTIK_BOOTSTRAP_PASSWORD",
      valueFrom: {
        secretKeyRef: {
          name: secrets.metadata.name,
          key: "AUTHENTIK_BOOTSTRAP_PASSWORD",
        },
      },
    },
    {
      name: "AUTHENTIK_BOOTSTRAP_EMAIL",
      valueFrom: {
        secretKeyRef: {
          name: secrets.metadata.name,
          key: "AUTHENTIK_BOOTSTRAP_EMAIL",
        },
      },
    },
  ];

  // 5. Authentik Server Deployment & Service
  const serverName = `${name}-server`;
  const serverDeployment = new k8s.apps.v1.Deployment(serverName, {
    metadata: {
      name: serverName,
      namespace,
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: serverName } },
      template: {
        metadata: { labels: { app: serverName } },
        spec: {
          containers: [{
            name: "server",
            image: image,
            args: ["server"],
            ports: [{ containerPort: 9000, name: "http" }],
            env: commonEnv,
            volumeMounts: [
              { name: "media", mountPath: "/media" },
              { name: "custom-templates", mountPath: "/templates" },
            ],
          }],
          volumes: [
            { name: "media", persistentVolumeClaim: { claimName: mediaPvc.metadata.name } },
            { name: "custom-templates", persistentVolumeClaim: { claimName: templatesPvc.metadata.name } },
          ],
        },
      },
    },
  }, { dependsOn: [mediaPvc, templatesPvc, secrets, redisService] });

  const serverService = new k8s.core.v1.Service(serverName, {
    metadata: {
      name: serverName,
      namespace,
    },
    spec: {
      ports: [{ port: 80, targetPort: 9000, protocol: "TCP", name: "http" }],
      selector: { app: serverName },
    },
  }, { dependsOn: serverDeployment });

  // 6. Authentik Worker Deployment
  const workerName = `${name}-worker`;
  const workerDeployment = new k8s.apps.v1.Deployment(workerName, {
    metadata: {
      name: workerName,
      namespace,
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: workerName } },
      template: {
        metadata: { labels: { app: workerName } },
        spec: {
          containers: [{
            name: "worker",
            image: image,
            args: ["worker"],
            env: commonEnv,
            volumeMounts: [
              { name: "media", mountPath: "/media" },
              { name: "custom-templates", mountPath: "/templates" },
            ],
          }],
          volumes: [
            { name: "media", persistentVolumeClaim: { claimName: mediaPvc.metadata.name } },
            { name: "custom-templates", persistentVolumeClaim: { claimName: templatesPvc.metadata.name } },
          ],
        },
      },
    },
  }, { dependsOn: [mediaPvc, templatesPvc, secrets, redisService] });

  // 7. Traefik Ingress with Automatic Let's Encrypt TLS Provisioning
  const ingress = new k8s.networking.v1.Ingress(`${name}-ingress`, {
    metadata: {
      name: `${name}-ingress`,
      namespace,
      annotations: {
        // Triggers cert-manager to provision the certificate
        "cert-manager.io/cluster-issuer": "letsencrypt-prod",
        // Force HTTPS via Traefik configurations
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
        "traefik.ingress.kubernetes.io/router.tls": "true",
      },
    },
    spec: {
      ingressClassName: "traefik",
      rules: [{
        host: "auth.gdario.dev",
        http: {
          paths: [{
            path: "/",
            pathType: "Prefix",
            backend: {
              service: {
                name: serverService.metadata.name,
                port: { number: 80 },
              },
            },
          }],
        },
      }],
      tls: [{
        hosts: ["auth.gdario.dev"],
        secretName: "authentik-tls-cert", // Where cert-manager stores the issued certificate
      }],
    },
  }, { dependsOn: [serverService] });

  return {
    redisService,
    serverService,
    ingress,
    workerDeployment,
  };
}
