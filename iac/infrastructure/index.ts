import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { SelfhostedApp } from "../library/selfhosted-component";
import { configureNamespaceSecurity } from "../selfhosted/security";
import { Labels } from "../selfhosted/labels";
import { postgresClientImage } from "../shared-resources/shared-postgres";
import { configureAuthentik } from "./authentik";

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
  const kimiApiKey = config.requireSecret("kimiApiKey");

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
              { name: "DB_HOST", value: "shared-postgres.shared-resources.svc.cluster.local" },
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
  # Provider-Prefixed Aliases (Stable names for your apps)
  # Pricing source: Moonshot AI Kimi API Platform (https://platform.kimi.com/docs/pricing/chat)
  # Rates fetched 2026-08-17: kimi-k2.6 ¥6.50/1M input, ¥27.00/1M output;
  # kimi-k2.7-code ¥6.50/1M input, ¥27.00/1M output. Converted at USD/CNY 0.148.
  # Disabled: kimi-thinking is too expensive for routine use.
  # - model_name: kimi-thinking
  #   litellm_params:
  #     model: openai/kimi-k2.7-code
  #     api_key: "os.environ/KIMI_API_KEY"
  #     api_base: "https://api.moonshot.ai/v1"
  #     drop_params: true
  #     input_cost_per_token: 0.000000962
  #     output_cost_per_token: 0.000003996
  #     extra_body:
  #       thinking:
  #         type: "enabled"
  - model_name: kimi-fast
    litellm_params:
      model: openai/kimi-k2.6
      api_key: "os.environ/KIMI_API_KEY"
      api_base: "https://api.moonshot.ai/v1"
      drop_params: true
      input_cost_per_token: 0.000000962
      output_cost_per_token: 0.000003996
  - model_name: deepseek-pro
    litellm_params:
      model: deepseek/deepseek-v4-pro
      api_key: "os.environ/DEEPSEEK_API_KEY"
      drop_params: true
  - model_name: deepseek-fast
    litellm_params:
      model: deepseek/deepseek-v4-flash
      api_key: "os.environ/DEEPSEEK_API_KEY"
      drop_params: true
general_settings:
  master_key: "os.environ/LITELLM_MASTER_KEY"
  store_model_in_db: true
  store_prompts_in_spend_logs: true
  maximum_spend_logs_retention_period: "30d"
  maximum_spend_logs_retention_interval: "1d"
litellm_settings:
  # Disable auth on /metrics so Prometheus can scrape inside the cluster without credentials.
  # This setting is only honored under litellm_settings, not general_settings.
  require_auth_for_metrics_endpoint: false
  # Activates the prometheus_client /metrics endpoint with LLM cost and usage counters.
  # Must be nested under litellm_settings — top-level callbacks key is ignored by LiteLLM.
  callbacks:
    - prometheus
`
    }
  }, { dependsOn: [namespace] });

  // Deploy LiteLLM using standard self-hosted app module. This exposes the proxy
  // publicly with automatic Let's Encrypt TLS cert management via Traefik.
  const app = new SelfhostedApp("litellm", {
    namespace: namespaceName,
    image: "ghcr.io/berriai/litellm:latest",
    containerPort: 4000,
    exposeType: "public",
    host: "litellm.gdario.dev",
    rateLimit: false,
    // uvicorn binds to 0.0.0.0 (IPv4 only). The default dual-stack service policy
    // generates an IPv6 endpoint alongside the IPv4 one, which Traefik round-robins
    // to — causing every other request to fail with connection refused → 502.
    ipFamilyPolicy: "SingleStack",
    ipFamilies: ["IPv4"],
    // Without these probes, Kubernetes marks the pod Ready as soon as the
    // process starts — before Prisma migrations and uvicorn finish initializing.
    // This causes Traefik to forward requests to an unready pod, which
    // Cloudflare reports as a 502 on every rolling deployment.
    readinessProbe: {
      httpGet: { path: "/health/readiness", port: 4000 },
      initialDelaySeconds: 5,
      periodSeconds: 10,
      failureThreshold: 3,
    },
    livenessProbe: {
      httpGet: { path: "/health/liveness", port: 4000 },
      initialDelaySeconds: 30,
      periodSeconds: 30,
      failureThreshold: 3,
    },
    labels: {
      // Require network access to the PostgreSQL server in the selfhosted namespace
      [Labels.Network.AllowPostgres]: "true",
      // Require network access to the Authentik OIDC server for token and user validation
      [Labels.Network.AllowAuthentik]: "true",
    },
    secrets: {
      // Connect to PostgreSQL DB in the selfhosted namespace.
      "DATABASE_URL": pulumi.interpolate`postgresql://litellm:${litellmDbPassword}@shared-postgres.shared-resources.svc.cluster.local:5432/litellm`,
      "LITELLM_MASTER_KEY": litellmMasterKey,
      "GENERIC_CLIENT_SECRET": litellmSecret,
      "DEEPSEEK_API_KEY": deepseekApiKey,
      // Moonshot AI / Kimi provider key. Exposed under both KIMI_API_KEY and MOONSHOT_API_KEY so LiteLLM supports either model alias convention.
      "KIMI_API_KEY": kimiApiKey,
      "MOONSHOT_API_KEY": kimiApiKey,
    },
    env: [
      { name: "GENERIC_CLIENT_ID", value: "litellm-client-id" },
      { name: "GENERIC_AUTHORIZATION_ENDPOINT", value: "https://auth.gdario.dev/application/o/authorize/" },
      { name: "GENERIC_TOKEN_ENDPOINT", value: "https://auth.gdario.dev/application/o/token/" },
      { name: "GENERIC_USERINFO_ENDPOINT", value: "https://auth.gdario.dev/application/o/userinfo/" },
      { name: "PROXY_BASE_URL", value: "https://litellm.gdario.dev" },
      { name: "FORWARDED_ALLOW_IPS", value: "*" },
      { name: "GENERIC_ROLE_MAPPINGS_GROUP_CLAIM", value: "groups" },
      // Maps the Authentik group "litellm-admins" to LiteLLM's internal "proxy_admin" role.
      { name: "GENERIC_ROLE_MAPPINGS_ROLES", value: '{"proxy_admin": ["litellm-admins"]}' },
      { name: "GENERIC_ROLE_MAPPINGS_DEFAULT_ROLE", value: "internal_user" },
      // prometheus_client uses this directory to aggregate per-worker counters.
      // Without it, each uvicorn worker maintains an isolated registry and only
      // one worker's metrics surface on any given scrape — making cost totals unreliable.
      { name: "PROMETHEUS_MULTIPROC_DIR", value: "/tmp/prometheus-multiproc" },
    ],
    databases: [
      {
        type: "postgres",
        databaseName: "litellm",
        host: "shared-postgres.shared-resources.svc.cluster.local",
        username: "litellm",
        passwordSecret: litellmDbPassword,
      },
    ],
    volumes: [
      {
        name: "litellm-config-volume",
        mountPath: "/app/config",
        configMap: {
          name: litellmConfigMap.metadata.name,
        },
      },
      {
        name: "prometheus-multiproc",
        mountPath: "/tmp/prometheus-multiproc",
        isEphemeral: true,
      },
    ],
    command: ["litellm"],
    args: ["--config", "/app/config/config.yaml", "--port", "4000"],
    dependencies: [litellmConfigMap, dbInitJob],
  });

  // Block external access to /metrics at the Traefik ingress layer.
  // LiteLLM's prometheus callback disables auth on /metrics so Prometheus can scrape
  // inside the cluster without credentials. Without this route, the same unauthenticated
  // endpoint would be reachable publicly via Traefik at https://litellm.gdario.dev/metrics.
  //
  // A higher-priority IngressRoute intercepts PathPrefix('/metrics') before the main
  // catch-all route (priority 10 set by Traefik by default) and routes it to
  // noop@internal — Traefik's built-in sink that returns 418 with no body.
  // Prometheus scrapes the pod IP directly and is unaffected by this rule.
  const blockMetricsRoute = new k8s.apiextensions.CustomResource("litellm-block-metrics-route", {
    apiVersion: "traefik.io/v1alpha1",
    kind: "IngressRoute",
    metadata: {
      name: "litellm-block-metrics",
      namespace: namespaceName,
    },
    spec: {
      entryPoints: ["websecure"],
      routes: [{
        match: "Host(`litellm.gdario.dev`) && PathPrefix(`/metrics`)",
        // Priority must exceed the default catch-all route priority (rule length = ~25)
        // to ensure this rule is evaluated first by Traefik's router.
        priority: 1000,
        kind: "Rule",
        services: [{
          name: "noop@internal",
          kind: "TraefikService",
        }],
      }],
    },
  }, { dependsOn: [app.service] });

  // Zero-trust baseline policy for the new namespace to block lateral traffic movement,
  // while allowing cert-manager and prometheus metric collection.
  const security = configureNamespaceSecurity({
    namespace: namespaceName,
    dependencies: [app.deployment],
    namePrefix: "infrastructure-",
  });

  // ServiceMonitor for Prometheus Operator to scrape LiteLLM's native /metrics endpoint.
  // LiteLLM exposes prometheus_client metrics on the same port as its API (4000), so no
  // extra sidecar or separate service is needed. The existing allowMonitoringScrape
  // NetworkPolicy in this namespace already permits ingress from the monitoring namespace.
  const serviceMonitor = new k8s.apiextensions.CustomResource("litellm-service-monitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
      name: "litellm",
      namespace: namespaceName,
      labels: { app: "litellm" },
    },
    spec: {
      selector: { matchLabels: { app: "litellm" } },
      // Explicitly scope discovery to the infrastructure namespace so Prometheus Operator
      // resolves this cross-namespace target even when namespaceSelector defaults are restrictive.
      namespaceSelector: {
        matchNames: ["infrastructure"],
      },
      endpoints: [{
        port: "http",
        path: "/metrics",
        interval: "30s",
      }],
    },
  }, { dependsOn: [app.service, security.allowMonitoringScrape] });

  // Allow Hermes Agent in the selfhosted namespace and autonomous-agent in the default namespace
  // to access the LiteLLM service in the infrastructure namespace securely.
  const allowAgentsToLiteLLM = new k8s.networking.v1.NetworkPolicy("litellm-allow-agents", {
    metadata: {
      name: "litellm-allow-agents",
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
            {
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": "default",
                },
              },
              podSelector: {
                matchLabels: {
                  app: "autonomous-agent",
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

  // DaemonSet to bump inotify limits on all nodes to fix fsnotify watcher errors
  // in applications like Grafana or Syncthing.
  const sysctlTuner = new k8s.apps.v1.DaemonSet("sysctl-tuner", {
    metadata: {
      name: "sysctl-tuner",
      namespace: "kube-system",
    },
    spec: {
      selector: {
        matchLabels: { app: "sysctl-tuner" },
      },
      template: {
        metadata: {
          labels: { app: "sysctl-tuner" },
        },
        spec: {
          hostNetwork: true,
          hostPID: true,
          containers: [
            {
              name: "sysctl-tuner",
              image: "alpine:latest",
              command: ["/bin/sh", "-c"],
              args: ["sysctl -w fs.inotify.max_user_watches=524288 && sysctl -w fs.inotify.max_user_instances=8192 && sleep infinity"],
              securityContext: {
                privileged: true,
              },
            },
          ],
        },
      },
    },
  });

  // Declaratively enforce the Kata Containers runtime node label on the worker node
  // so that node resets or re-initializations preserve the katacontainers.io/kata-runtime label.
  const kataNodeLabel = new k8s.core.v1.NodePatch("kata-node-label-debian", {
    metadata: {
      name: "debian",
      labels: {
        "katacontainers.io/kata-runtime": "true",
      },
    },
  }, { dependsOn: [kataDeploy] });

  const authentik = configureAuthentik(namespaceName, []);

  return {
    namespace: namespaceName,
    app,
    security,
    serviceMonitor,
    blockMetricsRoute,
    dbInitJob,
    kataDeploy,
    kataNodeLabel,
    sysctlTuner,
    authentik,
  };
}
