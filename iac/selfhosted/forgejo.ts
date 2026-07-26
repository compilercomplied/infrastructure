import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createSelfhostedApp } from "../library/selfhosted-app";
import { createBackupJob } from "../maintenance/backup";
import { Labels } from "./labels";
import { postgresClientImage } from "./shared-postgres";

// Load the standalone script files to satisfy the script-ownership guidelines.
// This decouples script logic from the Pulumi infrastructure definition.
const dbInitScriptContent = fs.readFileSync(path.join(__dirname, "../maintenance/scripts/init-forgejo-db.sh"), "utf8");
const bootstrapScriptContent = fs.readFileSync(path.join(__dirname, "../maintenance/scripts/bootstrap-forgejo.sh"), "utf8");
const pruneScriptContent = fs.readFileSync(path.join(__dirname, "../maintenance/scripts/prune-forgejo-history.py"), "utf8");

export function configureForgejo(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "forgejo";
  const image = "codeberg.org/forgejo/forgejo:15.0.3";

  const config = new pulumi.Config("selfhosted");
  const forgejoDbPassword = config.requireSecret("forgejoDbPassword");
  const forgejoSecret = config.requireSecret("forgejo-secret");
  const userGdarioEmail = config.requireSecret("user-gdario-email");
  const postgresPassword = config.requireSecret("postgresPassword");

  // Derive a deterministic 40-character hex secret for offline runner registration.
  // Using a deterministic hash of the main forgejoSecret ensures the registration is stable
  // and does not change across Pulumi runs.
  const runnerSecret = pulumi.secret(forgejoSecret.apply(s =>
    crypto.createHash("sha256").update(s + "runner-salt-v1").digest("hex").substring(0, 40)
  ));

  // 1. ConfigMaps for Database Init and Container Bootstrap Scripts
  const dbScriptsConfigMap = new k8s.core.v1.ConfigMap(`${name}-db-init-scripts`, {
    metadata: {
      name: `${name}-db-init-scripts`,
      namespace,
    },
    data: {
      "init-forgejo-db.sh": dbInitScriptContent,
    },
  }, { dependsOn: dependencies });

  const bootstrapConfigMap = new k8s.core.v1.ConfigMap(`${name}-bootstrap-scripts`, {
    metadata: {
      name: `${name}-bootstrap-scripts`,
      namespace,
    },
    data: {
      "bootstrap-forgejo.sh": bootstrapScriptContent,
    },
  }, { dependsOn: dependencies });

  // Generate a hash of OIDC secrets and script contents to trigger database initialization Job replacement when modified.
  const dbInitHash = pulumi.all([forgejoDbPassword, postgresPassword, dbInitScriptContent]).apply(([dbPass, adminPass, script]) => {
    return crypto.createHash("sha256").update(dbPass + adminPass + script).digest("hex");
  });

  // 2. Database Initialization Job (Zero ClickOps database and user setup)
  const dbInitJob = new k8s.batch.v1.Job(`init-${name}-db`, {
    metadata: {
      namespace,
      annotations: {
        "db-init-hash": dbInitHash,
      },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            "db-init-hash": dbInitHash,
          },
          labels: {
            [Labels.Network.AllowPostgres]: "true",
          },
        },
        spec: {
          restartPolicy: "Never",
          containers: [{
            name: "db-init",
            image: postgresClientImage,
            command: ["/bin/sh", "/scripts/init-forgejo-db.sh"],
            env: [
              { name: "DB_HOST", value: "shared-postgres.selfhosted.svc.cluster.local" },
              { name: "DB_NAME", value: name },
              { name: "DB_USER", value: name },
              {
                name: "DB_PASSWORD",
                valueFrom: {
                  secretKeyRef: {
                    name: `${name}-secrets-dbinit`,
                    key: "DB_PASSWORD",
                  },
                },
              },
              {
                name: "ADMIN_PASSWORD",
                valueFrom: {
                  secretKeyRef: {
                    name: `${name}-secrets-dbinit`,
                    key: "ADMIN_PASSWORD",
                  },
                },
              },
            ],
            volumeMounts: [{
              name: "scripts",
              mountPath: "/scripts",
            }],
          }],
          volumes: [{
            name: "scripts",
            configMap: {
              name: dbScriptsConfigMap.metadata.name,
              defaultMode: 0o755,
            },
          }],
        },
      },
    },
  }, {
    dependsOn: [dbScriptsConfigMap, ...dependencies],
    replaceOnChanges: ["metadata.annotations"],
    deleteBeforeReplace: true,
  });

  // Create a separate secret for the DB init job to keep passwords isolated during initialization.
  const dbInitSecrets = new k8s.core.v1.Secret(`${name}-secrets-dbinit`, {
    metadata: {
      name: `${name}-secrets-dbinit`,
      namespace,
    },
    stringData: {
      "DB_PASSWORD": forgejoDbPassword,
      "ADMIN_PASSWORD": postgresPassword,
    },
  }, { dependsOn: dependencies });

  // Add DB secrets dependency to the initialization job
  const jobWithSecrets = dbInitJob; // Implicitly depends on secret due to env mappings, but we declare it to ensure ordering
  
  // 3. Deployment and Ingress configuration using the selfhosted-app library
  const app = createSelfhostedApp({
    name,
    namespace,
    image,
    containerPort: 3000,
    exposeType: "public",
    host: "git.gdario.dev",
    labels: {
      [Labels.Network.AllowPostgres]: "true",
      [Labels.Network.AllowAuthentik]: "true",
    },
    secrets: {
      "FORGEJO__database__PASSWD": forgejoDbPassword,
      "AUTHENTIK_CLIENT_SECRET": forgejoSecret,
      "USER_EMAIL": userGdarioEmail,
      "RUNNER_SECRET": runnerSecret,
    },
    env: [
      { name: "FORGEJO__database__DB_TYPE", value: "postgres" },
      { name: "FORGEJO__database__HOST", value: "shared-postgres.selfhosted.svc.cluster.local:5432" },
      { name: "FORGEJO__database__NAME", value: name },
      { name: "FORGEJO__database__USER", value: name },
      { name: "FORGEJO__server__DOMAIN", value: "git.gdario.dev" },
      { name: "FORGEJO__server__SSH_DOMAIN", value: "git.gdario.dev" },
      { name: "FORGEJO__server__SSH_PORT", value: "2222" },
      { name: "FORGEJO__server__SSH_LISTEN_PORT", value: "22" },
      { name: "FORGEJO__server__ROOT_URL", value: "https://git.gdario.dev/" },
      { name: "FORGEJO__security__INSTALL_LOCK", value: "true" },
      { name: "FORGEJO__service__DISABLE_REGISTRATION", value: "true" },
      { name: "FORGEJO__service__ALLOW_ONLY_EXTERNAL_REGISTRATION", value: "false" },
      { name: "FORGEJO__service__ENABLE_BASIC_AUTHENTICATION", value: "false" },

      { name: "FORGEJO__openid__ENABLE_OPENID_SIGNIN", value: "false" },
      { name: "FORGEJO__oauth2_client__ENABLE_AUTO_REGISTRATION", value: "true" },
      { name: "FORGEJO__oauth2_client__ACCOUNT_LINKING", value: "auto" },
      { name: "FORGEJO__actions__ENABLED", value: "true" },
      // Enabling push-to-create allows automation pipelines to provision repositories on the fly
      // during their initial push, removing any manual UI interaction (ClickOps) for repo creation.
      { name: "FORGEJO__repository__ENABLE_PUSH_CREATE_USER", value: "true" },
      { name: "FORGEJO__repository__ENABLE_PUSH_CREATE_ORG", value: "true" },
    ],
    volumes: [
      {
        name: "forgejo-data",
        mountPath: "/data",
        size: "10Gi",
        pvcName: "forgejo-pvc",
      },
      {
        name: "bootstrap-scripts",
        mountPath: "/scripts",
        configMap: {
          name: bootstrapConfigMap.metadata.name,
          defaultMode: 0o755,
        },
      } as any, // Cast as any because VolumeConfig has basic typing
    ],
    command: ["/bin/bash", "/scripts/bootstrap-forgejo.sh"],
    strategy: {
      type: "Recreate",
      rollingUpdate: null as any,
    },
    readinessProbe: {
      httpGet: {
        path: "/user/login",
        port: 3000,
      },
      initialDelaySeconds: 5,
      periodSeconds: 5,
    },
    livenessProbe: {
      httpGet: {
        path: "/user/login",
        port: 3000,
      },
      initialDelaySeconds: 15,
      periodSeconds: 10,
    },
    dependencies: [...dependencies, bootstrapConfigMap, dbInitSecrets, jobWithSecrets],
  });

  // 4. Git SSH Service Exposure
  // Expose the SSH daemon (port 22 targetPort) publicly on port 2222 using a LoadBalancer service.
  const sshService = new k8s.core.v1.Service(`${name}-ssh`, {
    metadata: {
      name: `${name}-ssh`,
      namespace,
    },
    spec: {
      type: "LoadBalancer",
      ports: [
        { port: 2222, targetPort: 22, protocol: "TCP", name: "ssh" },
      ],
      selector: { app: name },
    },
  }, { dependsOn: app.deployment });

  // 5. NetworkPolicy for SSH traffic
  // Allows incoming SSH connections to the pod from any source since users clone over public internet.
  const sshPolicy = new k8s.networking.v1.NetworkPolicy(`${name}-allow-ssh`, {
    metadata: {
      name: `${name}-allow-ssh`,
      namespace,
    },
    spec: {
      podSelector: {
        matchLabels: {
          app: name,
        },
      },
      ingress: [
        {
          ports: [
            { protocol: "TCP", port: 22 },
          ],
        },
      ],
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: app.deployment });

  // 5a. NetworkPolicy for internal HTTP traffic (e.g. from forgejo-mcp and forgejo-runner)
  // This explicitly permits cluster-internal HTTP traffic to Forgejo from its associated tooling.
  const internalHttpPolicy = new k8s.networking.v1.NetworkPolicy(`${name}-allow-internal-http`, {
    metadata: {
      name: `${name}-allow-internal-http`,
      namespace,
    },
    spec: {
      podSelector: {
        matchLabels: {
          app: name,
        },
      },
      ingress: [
        {
          from: [
            {
              podSelector: {
                matchLabels: {
                  app: "forgejo-mcp",
                },
              },
            },
            {
              podSelector: {
                matchLabels: {
                  app: "forgejo-runner",
                },
              },
            },
            {
              podSelector: {
                matchLabels: {
                  app: `${name}-prune`,
                },
              },
            },
          ],
          ports: [
            { protocol: "TCP", port: 3000 },
          ],
        },
      ],
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: app.deployment });

  // 6. Restic Backups (Database stream and PVC files copy)
  const dbBackup = createBackupJob({
    appName: name,
    namespace,
    source: {
      type: "postgres",
      databaseName: name,
      dbHost: "shared-postgres.selfhosted.svc.cluster.local",
      dbUser: name,
      dbPasswordSecret: forgejoDbPassword,
    },
    dependencies: [...dependencies, app.deployment],
  });

  const filesBackup = createBackupJob({
    appName: name,
    namespace,
    source: {
      type: "pvc",
      pvcName: "forgejo-pvc",
      mountPath: "/data",
    },
    dependencies: [...dependencies, app.deployment],
  });

  // 7. Prune CronJob (Keeps last 5 actions and packages)
  const pruneScriptsConfigMap = new k8s.core.v1.ConfigMap(`${name}-prune-scripts`, {
    metadata: {
      name: `${name}-prune-scripts`,
      namespace,
    },
    data: {
      "prune-forgejo-history.py": pruneScriptContent,
    },
  }, { dependsOn: dependencies });

  const pruneCronJob = new k8s.batch.v1.CronJob(`${name}-prune`, {
    metadata: {
      name: `${name}-prune`,
      namespace,
    },
    spec: {
      schedule: "0 3 * * *", // Run every night at 3 AM
      concurrencyPolicy: "Forbid",
      jobTemplate: {
        spec: {
          template: {
            metadata: {
              labels: {
                app: `${name}-prune`,
              },
            },
            spec: {
              restartPolicy: "OnFailure",
              containers: [{
                name: "pruner",
                image: "python:3.11-alpine",
                command: ["/usr/local/bin/python", "/scripts/prune-forgejo-history.py"],
                env: [
                  // Port 80 is the Kubernetes Service port, not the container port (3000).
                  // Pod-to-pod traffic must go through the Service, so :3000 would be refused.
                  { name: "GITEA_HOST", value: `http://${name}.selfhosted.svc.cluster.local:80` },
                  // Explicit token path so a future mountPath rename doesn't silently break auth.
                  { name: "GITEA_TOKEN_FILE", value: "/forgejo-data/gitea/hermes-token.txt" },
                ],
                volumeMounts: [
                  { name: "scripts", mountPath: "/scripts" },
                  { name: "forgejo-data", mountPath: "/forgejo-data", readOnly: true },
                ],
              }],
              volumes: [
                {
                  name: "scripts",
                  configMap: {
                    name: pruneScriptsConfigMap.metadata.name,
                    defaultMode: 0o755,
                  },
                },
                {
                  name: "forgejo-data",
                  persistentVolumeClaim: {
                    claimName: "forgejo-pvc",
                  },
                },
              ],
              affinity: {
                podAffinity: {
                  requiredDuringSchedulingIgnoredDuringExecution: [
                    {
                      labelSelector: {
                        matchExpressions: [
                          {
                            key: "app",
                            operator: "In",
                            values: [name],
                          },
                        ],
                      },
                      topologyKey: "kubernetes.io/hostname",
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
  }, { dependsOn: [...dependencies, app.deployment, pruneScriptsConfigMap] });

  return {
    ...app,
    sshService,
    sshPolicy,
    internalHttpPolicy,
    dbBackup,
    filesBackup,
    runnerSecret,
    pruneCronJob,
    pruneScriptsConfigMap,
  };
}
