import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createBackupJob } from "../../maintenance/backup";
import { createPVC } from "../../library/k8s-pvc";
import { getAuthorizedUsers } from "../../selfhosted/users";
import { createLetsEncryptIngress } from "../../library/ingress";
import { createAuthentikOpenId } from "../../library/authentik";

export interface HermesAgentArgs {
  namespace: pulumi.Input<string>;
  dependencies?: pulumi.Resource[];
}

/**
 * Standardized Component Resource for deploying an instance of Hermes Agent.
 * Grouping resources inside this component prepares the architecture for multi-tenant scaling 
 * (one instance per user) while keeping name scopes and network routing encapsulated.
 */
export class HermesAgent extends pulumi.ComponentResource {
  public readonly deployment: k8s.apps.v1.Deployment;
  public readonly service: k8s.core.v1.Service;
  public readonly ingress: k8s.networking.v1.Ingress;
  public readonly apiIngress: k8s.networking.v1.Ingress;
  public readonly provider: any;
  public readonly app: any;
  public readonly dataBackup: k8s.batch.v1.CronJob;

  constructor(name: string, args: HermesAgentArgs, opts?: pulumi.ComponentResourceOptions) {
    super("custom:selfhosted:HermesAgent", name, {}, opts);

    const { namespace, dependencies = [] } = args;

    const config = new pulumi.Config("selfhosted");
    const deepseekApiKey = config.requireSecret("deepseekApiKey");
    const telegramBotToken = config.requireSecret("telegramBotToken");
    const hermesSecret = config.requireSecret("hermesSecret");

    const host = "hermes.gdario.dev";

    // To prevent Pulumi from deleting and recreating the existing resources during
    // this refactoring, we define an alias mapping that points to the previous parent
    // (which was the root stack). This preserves resource URNs.
    const componentAlias = { parent: pulumi.rootStackResource };

    // 1. Create OIDC Provider and Application in Authentik using library wrapper
    const sso = createAuthentikOpenId({
      name: "Hermes Agent",
      slug: "hermes",
      clientId: "hermes-client-id",
      clientSecret: hermesSecret,
      clientType: "public",
      redirectUris: [`https://${host}/auth/callback`],
      launchUrl: `https://${host}`,
      parent: this,
      aliases: [componentAlias],
    });
    this.provider = sso.provider;
    this.app = sso.app;

    // 2. Kubernetes Persistent Volume Claim
    const pvc = createPVC({
      name: `${name}-pvc`,
      namespace,
      size: "256Mi",
      dependencies,
      parent: this,
      aliases: [componentAlias],
    });

    // 3. Kubernetes Secrets for credentials
    const secrets = new k8s.core.v1.Secret(`${name}-secrets`, {
      metadata: {
        name: `${name}-secrets`,
        namespace,
      },
      stringData: {
        "CUSTOM_API_KEY": deepseekApiKey,
        "DEEPSEEK_API_KEY": deepseekApiKey,
        "TELEGRAM_BOT_TOKEN": telegramBotToken,
        "API_SERVER_KEY": hermesSecret,
      },
    }, { dependsOn: dependencies, parent: this, aliases: [componentAlias] });

    // 4. Kubernetes ConfigMap containing Hermes config.yaml
    const users = getAuthorizedUsers();
    const allowedChats = pulumi.all(users.map(u => u.telegramId));
    const allowedUsersString = allowedChats.apply(chats => chats.join(","));

    const configTemplate = fs.readFileSync(path.resolve(__dirname, "./templates/hermes-config.yaml"), "utf-8");

    // Because Kubernetes ConfigMap subPath volume mounts are read-only and locked at the OS level,
    // the Hermes Agent UI's atomic config-writing mechanism (which replaces the file via os.replace)
    // fails with a "Device or resource busy" (Errno 16) error when users try to toggle skills or modify settings.
    // To solve this, we mount the ConfigMap to a temporary /opt/config-src path and copy it to the writable
    // PVC volume at /opt/data/config.yaml using an initContainer. The sync-config.py script copies the IaC seed configuration
    // only if it does not already exist, giving the user full ownership of their config.
    const configMap = new k8s.core.v1.ConfigMap(`${name}-config`, {
      metadata: {
        name: `${name}-config`,
        namespace,
      },
      data: {
        "config.yaml": allowedChats.apply(chats => {
          const chatLines = chats.map(chat => `    - "${chat}"`).join("\n");
          return configTemplate.replace("    # {{ALLOWED_CHATS}}", chatLines);
        }),
      },
    }, { dependsOn: dependencies, parent: this, aliases: [componentAlias] });

    const syncConfigScript = fs.readFileSync(path.resolve(__dirname, "../../maintenance/scripts/sync-config.py"), "utf-8");

    const scriptsConfigMap = new k8s.core.v1.ConfigMap(`${name}-scripts`, {
      metadata: {
        name: `${name}-scripts`,
        namespace,
      },
      data: {
        "sync-config.py": syncConfigScript,
      },
    }, { dependsOn: dependencies, parent: this, aliases: [componentAlias] });

    // 5. Deployment for Hermes Agent
    const deployment = new k8s.apps.v1.Deployment(name, {
      metadata: {
        name,
        namespace,
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            initContainers: [{
              name: "sync-config",
              image: "nousresearch/hermes-agent:latest",
              command: ["/opt/hermes/.venv/bin/python", "/opt/scripts/sync-config.py"],
              volumeMounts: [
                { name: "data", mountPath: "/opt/data" },
                { name: "config-src", mountPath: "/opt/config-src" },
                { name: "scripts", mountPath: "/opt/scripts" },
              ],
            }],
            containers: [{
              name: "hermes-agent",
              image: "nousresearch/hermes-agent:latest",
              args: ["gateway", "run"],
              ports: [
                { containerPort: 9119, name: "http" },
                { containerPort: 8642, name: "api" },
              ],
              env: [
                { name: "HERMES_DASHBOARD", value: "1" },
                { name: "HERMES_DASHBOARD_PUBLIC_URL", value: `https://${host}` },
                { name: "HERMES_DASHBOARD_OIDC_ISSUER", value: "https://auth.gdario.dev/application/o/hermes/" },
                { name: "HERMES_DASHBOARD_OIDC_CLIENT_ID", value: "hermes-client-id" },
                { name: "HERMES_DASHBOARD_OIDC_CLIENT_SECRET", value: hermesSecret },
                { name: "API_SERVER_ENABLED", value: "true" },
                { name: "API_SERVER_HOST", value: "0.0.0.0" },
                { name: "API_SERVER_CORS_ORIGINS", value: "*" },
                { name: "CUSTOM_BASE_URL", value: "https://api.deepseek.com/v1" },
                {
                  name: "CUSTOM_API_KEY",
                  valueFrom: {
                    secretKeyRef: {
                      name: secrets.metadata.name,
                      key: "CUSTOM_API_KEY",
                    },
                  },
                },
                {
                  name: "DEEPSEEK_API_KEY",
                  valueFrom: {
                    secretKeyRef: {
                      name: secrets.metadata.name,
                      key: "DEEPSEEK_API_KEY",
                    },
                  },
                },
                {
                  name: "TELEGRAM_BOT_TOKEN",
                  valueFrom: {
                    secretKeyRef: {
                      name: secrets.metadata.name,
                      key: "TELEGRAM_BOT_TOKEN",
                    },
                  },
                },
                {
                  name: "API_SERVER_KEY",
                  valueFrom: {
                    secretKeyRef: {
                      name: secrets.metadata.name,
                      key: "API_SERVER_KEY",
                    },
                  },
                },
                { name: "TELEGRAM_ALLOWED_USERS", value: allowedUsersString },
              ],
              volumeMounts: [
                { name: "data", mountPath: "/opt/data" },
              ],
            }],
            volumes: [
              { name: "data", persistentVolumeClaim: { claimName: pvc.metadata.name } },
              { name: "config-src", configMap: { name: configMap.metadata.name } },
              { name: "scripts", configMap: { name: scriptsConfigMap.metadata.name } },
            ],
          },
        },
      },
    }, { dependsOn: [pvc, secrets, configMap, scriptsConfigMap, ...dependencies], parent: this, aliases: [componentAlias] });
    this.deployment = deployment;

    // 6. Service exposing the dashboard and API
    const service = new k8s.core.v1.Service(name, {
      metadata: {
        name,
        namespace,
      },
      spec: {
        ports: [
          { port: 80, targetPort: 9119, protocol: "TCP", name: "http" },
          { port: 8642, targetPort: 8642, protocol: "TCP", name: "api" },
        ],
        selector: { app: name },
      },
    }, { dependsOn: deployment, parent: this, aliases: [componentAlias] });
    this.service = service;

    // 8. Ingress with Forward Auth Annotations for dashboard
    const ingress = new k8s.networking.v1.Ingress(`${name}-ingress`, {
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
                  name: service.metadata.name,
                  port: { number: 80 },
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
    }, { dependsOn: [service], parent: this, aliases: [componentAlias] });
    this.ingress = ingress;

    // 8b. API Ingress for OpenAI-compatible client API access.
    // We expose this without Authentik forward auth middleware to allow external OpenAI-compatible
    // clients (e.g. Android client apps) to authenticate natively via the API_SERVER_KEY bearer token.
    const apiIngress = createLetsEncryptIngress({
      name: `${name}-api`,
      namespace,
      host: "hermes-api.gdario.dev",
      serviceName: service.metadata.name,
      servicePort: 8642,
      dependencies: [service],
      parent: this,
      aliases: [componentAlias],
    });
    this.apiIngress = apiIngress;

    // 9. Back up the Hermes persistent volume data (databases, config, memories, and skills) daily.
    const dataBackup = createBackupJob({
      appName: name,
      namespace,
      source: {
        type: "pvc",
        pvcName: `${name}-pvc`,
        mountPath: "/opt/data",
      },
      dependencies: [...dependencies, deployment],
      parent: this,
      aliases: [componentAlias],
    });
    this.dataBackup = dataBackup;

    this.registerOutputs({});
  }
}
