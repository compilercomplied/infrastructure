import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import { createLetsEncryptIngress } from "../../library/ingress";
import { createPVC } from "../../library/k8s-pvc";
import { createBackupJob } from "../../operations/maintenance/backup";
import { Labels } from "../../workloads/selfhosted/labels";
import { authentikSettings } from "./authentik-settings";

export function configureAuthentik(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "authentik";
  const image = "ghcr.io/goauthentik/server:2026.5.2";

  const mediaPvc = createPVC({
    name: `${name}-media-pvc`,
    namespace,
    size: "2Gi",
    dependencies,
  });
 
  const templatesPvc = createPVC({
    name: `${name}-templates-pvc`,
    namespace,
    size: "2Gi",
    dependencies,
  });

  const secrets = new k8s.core.v1.Secret(`${name}-secrets`, {
    metadata: {
      name: `${name}-secrets`,
      namespace,
    },
    stringData: authentikSettings.secrets,
  }, { dependsOn: dependencies });

	// Redis is a hard dependency for authentik.
	// It is used as an internal task queue.
  const redisName = `${name}-redis`;
  const redisDeployment = new k8s.apps.v1.Deployment(`${redisName}`, {
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
            args: ["--requirepass", "$(REDIS_PASSWORD)"],
            env: [{
              name: "REDIS_PASSWORD",
              valueFrom: {
                secretKeyRef: {
                  name: secrets.metadata.name,
                  key: "AUTHENTIK_REDIS__PASSWORD",
                },
              },
            }],
          }],
        },
      },
    },
  }, { dependsOn: [...dependencies, secrets] });

  const redisService = new k8s.core.v1.Service(`${redisName}`, {
    metadata: {
      name: redisName,
      namespace,
    },
    spec: {
      ports: [{ port: 6379, targetPort: 6379, name: "redis" }],
      selector: { app: redisName },
    },
  }, { dependsOn: redisDeployment });

  const bootstrapOnlySecrets = new Set([
    "AUTHENTIK_BOOTSTRAP_PASSWORD",
    "AUTHENTIK_BOOTSTRAP_EMAIL",
  ]);
  const commonEnv = [
    { name: "AUTHENTIK_REDIS__HOST", value: redisService.metadata.name },
    ...Object.entries(authentikSettings.config).map(([name, value]) => ({ name, value })),
    ...Object.keys(authentikSettings.secrets)
      .filter(name => !bootstrapOnlySecrets.has(name))
      .map(name => ({
        name,
        valueFrom: {
          secretKeyRef: {
            name: secrets.metadata.name,
            key: name,
          },
        },
      })),
  ];

  // Load the standalone declarative YAML blueprint and package it in a ConfigMap.
  // This complies with the Tenets for Script Management (keeping blueprints out of code string blocks).
  const blueprintsConfigMap = new k8s.core.v1.ConfigMap(`${name}-blueprints`, {
    metadata: {
      name: `${name}-blueprints`,
      namespace,
    },
    data: {
      "cluster-bootstrap.yaml": fs.readFileSync(path.join(__dirname, "templates", "authentik-blueprints.yaml"), "utf-8"),
    },
  }, { dependsOn: dependencies });

  const serverName = `${name}-server`;
  const serverDeployment = new k8s.apps.v1.Deployment(`${serverName}`, {
    metadata: {
      name: serverName,
      namespace,
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: serverName } },
      template: {
        metadata: {
          labels: {
            app: serverName,
            [Labels.Network.AllowPostgres]: "true",
          },
        },
        spec: {
          containers: [{
            name: "authentik-server",
            image: image,
            args: ["server"],
            ports: [{ containerPort: 9000, name: "http" }],
            env: commonEnv,
            volumeMounts: [
              { name: "media", mountPath: "/media" },
              { name: "custom-templates", mountPath: "/templates" },
              { name: "blueprints", mountPath: "/blueprints/custom" },
            ],
          }],
          volumes: [
            { name: "media", persistentVolumeClaim: { claimName: mediaPvc.metadata.name } },
            { name: "custom-templates", persistentVolumeClaim: { claimName: templatesPvc.metadata.name } },
            { name: "blueprints", configMap: { name: blueprintsConfigMap.metadata.name } },
          ],
        },
      },
    },
  }, { dependsOn: [mediaPvc, templatesPvc, secrets, redisService, blueprintsConfigMap] });

  const serverService = new k8s.core.v1.Service(`${serverName}`, {
    metadata: {
      name: serverName,
      namespace,
    },
    spec: {
      ports: [{ port: 80, targetPort: 9000, protocol: "TCP", name: "http" }],
      selector: { app: serverName },
    },
  }, { dependsOn: serverDeployment });

  const workerName = `${name}-worker`;
  const workerDeployment = new k8s.apps.v1.Deployment(`${workerName}`, {
    metadata: {
      name: workerName,
      namespace,
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: workerName } },
      template: {
        metadata: {
          labels: {
            app: workerName,
            [Labels.Network.AllowPostgres]: "true",
          },
        },
        spec: {
          containers: [{
            name: "authentik-worker",
            image: image,
            args: ["worker"],
            env: commonEnv,
            volumeMounts: [
              { name: "media", mountPath: "/media" },
              { name: "custom-templates", mountPath: "/templates" },
              { name: "blueprints", mountPath: "/blueprints/custom" },
            ],
          }],
          volumes: [
            { name: "media", persistentVolumeClaim: { claimName: mediaPvc.metadata.name } },
            { name: "custom-templates", persistentVolumeClaim: { claimName: templatesPvc.metadata.name } },
            { name: "blueprints", configMap: { name: blueprintsConfigMap.metadata.name } },
          ],
        },
      },
    },
  }, { dependsOn: [mediaPvc, templatesPvc, secrets, redisService, blueprintsConfigMap] });

  const exposure = createLetsEncryptIngress({
    name,
    namespace,
    host: "auth.gdario.dev",
    serviceName: serverService.metadata.name,
    servicePort: 80,
    targetPort: 9000,
    podSelector: { app: serverName },
    dependencies: [serverService],
  });
  const ingress = exposure.ingress;
  const traefikPolicy = exposure.policy;

  // Back up the authentik PostgreSQL database containing all user credentials,
  // tokens, and configuration.
  const dbBackup = createBackupJob({
    appName: name,
    namespace,
    source: {
      type: "postgres",
      databaseName: "authentik",
      dbHost: "shared-postgres.shared-resources.svc.cluster.local",
      dbUser: "authentik",
      dbPasswordSecret: authentikSettings.databasePassword,
    },
    dependencies: [...dependencies, serverDeployment],
  });

  // Back up the media directory containing tenant custom logos and assets.
  const mediaBackup = createBackupJob({
    appName: name,
    namespace,
    source: {
      type: "pvc",
      pvcName: `${name}-media-pvc`,
      mountPath: "/media",
    },
    dependencies: [...dependencies, mediaPvc],
  });

  // Back up custom templates that contain branding or configuration.
  const templatesBackup = createBackupJob({
    appName: name,
    namespace,
    source: {
      type: "pvc",
      pvcName: `${name}-templates-pvc`,
      mountPath: "/templates",
    },
    dependencies: [...dependencies, templatesPvc],
  });

  // Ingress is restricted to pods carrying the network/allow-authentik label. Internal pods require direct access
  // to the Authentik Server to perform OIDC authentication and token validation.
  const internalPolicy = new k8s.networking.v1.NetworkPolicy(`${name}-server-allow-internal`, {
    metadata: {
      name: `${name}-server-allow-internal`,
      namespace,
    },
    spec: {
      podSelector: {
        matchLabels: { app: serverName },
      },
      ingress: [
        {
          from: [
            {
              podSelector: {
                matchLabels: {
                  [Labels.Network.AllowAuthentik]: "true",
                },
              },
            },
            {
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": "infrastructure",
                },
              },
              podSelector: {
                matchLabels: {
                  [Labels.Network.AllowAuthentik]: "true",
                },
              },
            },
            {
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": "forgejo",
                },
              },
              podSelector: {
                matchLabels: {
                  [Labels.Network.AllowAuthentik]: "true",
                },
              },
            },
            {
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": "agent-sidekicks",
                },
              },
              podSelector: {
                matchLabels: {
                  [Labels.Network.AllowAuthentik]: "true",
                },
              },
            },
          ],
          ports: [{ port: 9000 }],
        },
      ],
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: serverDeployment });

  // NetworkPolicy to allow only Authentik components to connect to Authentik Redis
  const redisPolicy = new k8s.networking.v1.NetworkPolicy(`${name}-redis-allow-ingress`, {
    metadata: {
      name: `${name}-redis-allow-ingress`,
      namespace,
    },
    spec: {
      podSelector: {
        matchLabels: { app: redisName },
      },
      ingress: [
        {
          from: [
            { podSelector: { matchLabels: { app: serverName } } },
            { podSelector: { matchLabels: { app: workerName } } },
            { podSelector: { matchLabels: { app: "authentik-patch" } } },
          ],
          ports: [{ port: 6379 }],
        },
      ],
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: redisDeployment });

  return {
    redisService,
    serverService,
    ingress,
    workerDeployment,
    dbBackup,
    mediaBackup,
    templatesBackup,
    internalPolicy,
    traefikPolicy,
    redisPolicy,
  };
}
