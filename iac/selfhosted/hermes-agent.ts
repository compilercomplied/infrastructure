import * as fs from "fs";
import * as path from "path";
import * as authentik from "@pulumi/authentik";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createBackupJob } from "../maintenance/backup";
import { getAuthorizedUsers } from "./users";

export function configureHermesAgent(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config("selfhosted");
  const deepseekApiKey = config.requireSecret("deepseekApiKey");
  const telegramBotToken = config.requireSecret("telegramBotToken");
  const hermesSecret = config.requireSecret("hermesSecret");

  const name = "hermes-agent";
  const host = "hermes.gdario.dev";

  // Create OIDC Provider and Application in Authentik
  const scopeOpenid = authentik.getPropertyMappingProviderScopeOutput({
    managed: "goauthentik.io/providers/oauth2/scope-openid",
  });
  const scopeProfile = authentik.getPropertyMappingProviderScopeOutput({
    managed: "goauthentik.io/providers/oauth2/scope-profile",
  });
  const scopeEmail = authentik.getPropertyMappingProviderScopeOutput({
    managed: "goauthentik.io/providers/oauth2/scope-email",
  });

  const provider = new authentik.ProviderOauth2("hermes-provider", {
    name: "Hermes SSO",
    clientId: "hermes-client-id",
    clientSecret: hermesSecret,
    clientType: "public",
    // Flow/Signing keys from pre-existing Authentik setups
    authorizationFlow: "9faae557-fad6-4f95-876c-545adc95b3e4",
    invalidationFlow: "12830a53-f573-488d-bdc2-f12ddc59c0a7",
    signingKey: "e96bc021-31ba-451e-b3ae-a7c62b7f1363",
    allowedRedirectUris: [{
      matching_mode: "strict",
      url: `https://${host}/auth/callback`,
    }],
    propertyMappings: [
      scopeOpenid.id,
      scopeProfile.id,
      scopeEmail.id,
    ],
  });

  const app = new authentik.Application("hermes-app", {
    name: "Hermes Agent",
    slug: "hermes",
    protocolProvider: provider.id.apply(id => parseInt(id)),
    metaLaunchUrl: `https://${host}`,
    metaPublisher: "GDario Labs",
  });

  // 2. Kubernetes Persistent Volume Claim
  const pvc = new k8s.core.v1.PersistentVolumeClaim(`${name}-pvc`, {
    metadata: {
      name: `${name}-pvc`,
      namespace,
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "local-path",
      resources: {
        requests: {
          storage: "256Mi",
        },
      },
    },
  }, { dependsOn: dependencies });

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
      // The API server requires a key to start, even when bound to 0.0.0.0.
      // Reusing hermesSecret satisfies this requirement securely.
      "API_SERVER_KEY": hermesSecret,
    },
  }, { dependsOn: dependencies });

  // 4. Kubernetes ConfigMap containing Hermes config.yaml
  const users = getAuthorizedUsers();
  const allowedChats = pulumi.all(users.map(u => u.telegramId));
  const allowedUsersString = allowedChats.apply(chats => chats.join(","));

  // Read the default configuration template from templates
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
  }, { dependsOn: dependencies });

  // Read the configuration sync/merge script from maintenance scripts
  const syncConfigScript = fs.readFileSync(path.resolve(__dirname, "../maintenance/scripts/sync-config.py"), "utf-8");

  const scriptsConfigMap = new k8s.core.v1.ConfigMap(`${name}-scripts`, {
    metadata: {
      name: `${name}-scripts`,
      namespace,
    },
    data: {
      "sync-config.py": syncConfigScript,
    },
  }, { dependsOn: dependencies });

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
            ports: [{ containerPort: 9119, name: "http" }],
            env: [
              { name: "HERMES_DASHBOARD", value: "1" },
              { name: "HERMES_DASHBOARD_PUBLIC_URL", value: `https://${host}` },
              { name: "HERMES_DASHBOARD_OIDC_ISSUER", value: "https://auth.gdario.dev/application/o/hermes/" },
              { name: "HERMES_DASHBOARD_OIDC_CLIENT_ID", value: "hermes-client-id" },
              { name: "HERMES_DASHBOARD_OIDC_CLIENT_SECRET", value: hermesSecret },
              { name: "API_SERVER_ENABLED", value: "true" },
              { name: "API_SERVER_HOST", value: "0.0.0.0" },
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
  }, { dependsOn: [pvc, secrets, configMap, scriptsConfigMap, ...dependencies] });

  // 6. Service exposing the dashboard
  const service = new k8s.core.v1.Service(name, {
    metadata: {
      name,
      namespace,
    },
    spec: {
      ports: [{ port: 80, targetPort: 9119, protocol: "TCP", name: "http" }],
      selector: { app: name },
    },
  }, { dependsOn: deployment });



  // 8. Ingress with Forward Auth Annotations
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
  }, { dependsOn: [service] });

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
  });

  return {
    deployment,
    service,
    ingress,
    provider,
    app,
    dataBackup,
  };
}
