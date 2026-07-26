import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { createSelfhostedApp } from "../library/selfhosted-app";
import { configureNamespaceSecurity } from "../selfhosted/security";
import { createBackupJob } from "../maintenance/backup";
import { Labels } from "../selfhosted/labels";
import { postgresClientImage } from "../selfhosted/shared-postgres";

export function configureInfrastructure() {
  // A dedicated namespace is created to isolate core infrastructure components
  // (like LiteLLM proxy) from general self-hosted services and user agents.
  const namespace = new k8s.core.v1.Namespace("infrastructure", {
    metadata: { name: "infrastructure" }
  });

  const namespaceName = namespace.metadata.name;

  const config = new pulumi.Config("selfhosted");
  const litellmDbPassword = config.requireSecret("litellmDbPassword");
  const litellmSecret = config.requireSecret("litellmSecret");
  const litellmMasterKey = config.requireSecret("litellmMasterKey");
  const postgresPassword = config.requireSecret("postgresPassword");
  const deepseekApiKey = config.requireSecret("deepseekApiKey");

  // Read the generic database initialization script. Reusing this script avoids
  // duplicating script files in the codebase.
  const dbInitScriptContent = fs.readFileSync(path.join(__dirname, "../maintenance/scripts/init-forgejo-db.sh"), "utf8");

  const dbScriptsConfigMap = new k8s.core.v1.ConfigMap("litellm-db-init-scripts", {
    metadata: {
      name: "litellm-db-init-scripts",
      namespace: namespaceName,
    },
    data: {
      "init-forgejo-db.sh": dbInitScriptContent,
    },
  }, { dependsOn: [namespace] });

  const dbInitSecrets = new k8s.core.v1.Secret("litellm-secrets-dbinit", {
    metadata: {
      name: "litellm-secrets-dbinit",
      namespace: namespaceName,
    },
    stringData: {
      "DB_PASSWORD": litellmDbPassword,
      "ADMIN_PASSWORD": postgresPassword,
    },
  }, { dependsOn: [namespace] });

  // Generate a hash of secrets and script content to trigger Job replacement when configuration changes.
  const dbInitHash = pulumi.all([litellmDbPassword, postgresPassword, dbInitScriptContent]).apply(([dbPass, adminPass, script]) => {
    return crypto.createHash("sha256").update(dbPass + adminPass + script).digest("hex");
  });

  // A database initialization Job is defined to programmatically create the LiteLLM
  // database and user inside the shared postgres cluster, ensuring Zero ClickOps.
  const dbInitJob = new k8s.batch.v1.Job("init-litellm-db", {
    metadata: {
      namespace: namespaceName,
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
              { name: "DB_NAME", value: "litellm" },
              { name: "DB_USER", value: "litellm" },
              {
                name: "DB_PASSWORD",
                valueFrom: {
                  secretKeyRef: {
                    name: dbInitSecrets.metadata.name,
                    key: "DB_PASSWORD",
                  },
                },
              },
              {
                name: "ADMIN_PASSWORD",
                valueFrom: {
                  secretKeyRef: {
                    name: dbInitSecrets.metadata.name,
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
    dependsOn: [dbScriptsConfigMap, dbInitSecrets],
    replaceOnChanges: ["metadata.annotations"],
    deleteBeforeReplace: true,
  });

  // LiteLLM requires a config.yaml to boot. We keep it minimal and route
  // dynamic settings (like keys, models, and routes) to the database.
  const litellmConfigMap = new k8s.core.v1.ConfigMap("litellm-config", {
    metadata: {
      name: "litellm-config",
      namespace: namespaceName,
    },
    data: {
      "config.yaml": `
model_list:
  - model_name: deepseek-v4-pro
    litellm_params:
      model: deepseek/deepseek-v4-pro
      api_key: "os.environ/DEEPSEEK_API_KEY"
  - model_name: deepseek-v4-flash
    litellm_params:
      model: deepseek/deepseek-v4-flash
      api_key: "os.environ/DEEPSEEK_API_KEY"
general_settings:
  master_key: "os.environ/LITELLM_MASTER_KEY"
  store_model_in_db: true
  store_prompts_in_spend_logs: true
  maximum_spend_logs_retention_period: "30d"
  maximum_spend_logs_retention_interval: "1d"
`
    }
  }, { dependsOn: [namespace] });

  // Deploy LiteLLM using standard self-hosted app module. This exposes the proxy
  // publicly with automatic Let's Encrypt TLS cert management via Traefik.
  const app = createSelfhostedApp({
    name: "litellm",
    namespace: namespaceName,
    image: "ghcr.io/berriai/litellm:latest",
    containerPort: 4000,
    exposeType: "public",
    host: "litellm.gdario.dev",
    labels: {
      // Require network access to the PostgreSQL server in the selfhosted namespace
      [Labels.Network.AllowPostgres]: "true",
      // Require network access to the Authentik OIDC server for token and user validation
      [Labels.Network.AllowAuthentik]: "true",
    },
    secrets: {
      // Connect to PostgreSQL DB in the selfhosted namespace.
      "DATABASE_URL": pulumi.interpolate`postgresql://litellm:${litellmDbPassword}@shared-postgres.selfhosted.svc.cluster.local:5432/litellm`,
      "LITELLM_MASTER_KEY": litellmMasterKey,
      "GENERIC_CLIENT_SECRET": litellmSecret,
      "DEEPSEEK_API_KEY": deepseekApiKey,
    },
    env: [
      { name: "GENERIC_CLIENT_ID", value: "litellm-client-id" },
      { name: "GENERIC_AUTHORIZATION_ENDPOINT", value: "https://auth.gdario.dev/application/o/authorize/" },
      { name: "GENERIC_TOKEN_ENDPOINT", value: "https://auth.gdario.dev/application/o/token/" },
      { name: "GENERIC_USERINFO_ENDPOINT", value: "https://auth.gdario.dev/application/o/userinfo/" },
      { name: "PROXY_BASE_URL", value: "https://litellm.gdario.dev" },
      { name: "GENERIC_ROLE_MAPPINGS_GROUP_CLAIM", value: "groups" },
      // Maps the Authentik group "litellm-admins" to LiteLLM's internal "proxy_admin" role.
      { name: "GENERIC_ROLE_MAPPINGS_ROLES", value: '{"proxy_admin": ["litellm-admins"]}' },
      { name: "GENERIC_ROLE_MAPPINGS_DEFAULT_ROLE", value: "internal_user" },
    ],
    volumes: [
      {
        name: "litellm-config-volume",
        mountPath: "/app/config",
        configMap: {
          name: litellmConfigMap.metadata.name,
        },
      },
    ],
    command: ["litellm"],
    args: ["--config", "/app/config/config.yaml", "--port", "4000"],
    dependencies: [litellmConfigMap, dbInitJob],
  });

  // Zero-trust baseline policy for the new namespace to block lateral traffic movement,
  // while allowing cert-manager and prometheus metric collection.
  const security = configureNamespaceSecurity({
    namespace: namespaceName,
    dependencies: [app.deployment],
    namePrefix: "infrastructure-",
  });

  // Backup job running Restic to dump the LiteLLM database to R2 storage daily.
  const dbBackup = createBackupJob({
    appName: "litellm",
    namespace: namespaceName,
    source: {
      type: "postgres",
      databaseName: "litellm",
      dbHost: "shared-postgres.selfhosted.svc.cluster.local",
      dbUser: "litellm",
      dbPasswordSecret: litellmDbPassword,
    },
    dependencies: [app.deployment],
  });

  // Allow Hermes Agent in the selfhosted namespace to access the LiteLLM service
  // in the infrastructure namespace securely.
  const allowHermesToLiteLLM = new k8s.networking.v1.NetworkPolicy("litellm-allow-hermes", {
    metadata: {
      name: "litellm-allow-hermes",
      namespace: namespaceName,
    },
    spec: {
      podSelector: {
        matchLabels: { app: "litellm" },
      },
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": "selfhosted",
                },
              },
              podSelector: {
                matchLabels: {
                  app: "hermes-agent",
                },
              },
            },
          ],
          ports: [{ port: 4000 }],
        },
      ],
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: [app.deployment] });

  // Kata Containers Deployment (kata-deploy)
  // This Helm chart deploys a privileged DaemonSet that installs the Kata Containers runtime
  // onto the host nodes and configures k3s' containerd to use it. It also automatically creates
  // the `kata` RuntimeClass. 
  // 
  // NOTE: This approach was chosen to respect the "Zero ClickOps" rule and keep all cluster
  // configuration centralized in the IaC. If managing host-level binaries via DaemonSet becomes
  // problematic, consider migrating this setup to the `ansible-playbook` host setup directly 
  // (installing kata packages and templating config.toml.tmpl via Ansible) and only keep the 
  // RuntimeClass definition here.
  const kataDeploy = new k8s.helm.v3.Release("kata-deploy", {
    chart: "./infrastructure/kata-deploy",
    namespace: "kube-system",
    values: {
      k8sDistribution: "k3s",
      runtimeClasses: {
        createDefault: true,
      },
    },
  });

  return {
    namespace: namespaceName,
    app,
    security,
    dbBackup,
    dbInitJob,
    kataDeploy,
  };
}
