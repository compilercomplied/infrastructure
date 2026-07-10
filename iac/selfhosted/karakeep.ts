import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createSelfhostedApp } from "../library/selfhosted-app";
import { createPVC } from "../library/k8s-pvc";
import { createBackupJob } from "../maintenance/backup";
import { Labels } from "./labels";

// These image versions are kept here as the single source of truth so that
// downstream jobs (e.g. backup CronJobs) can import them rather than
// re-declaring their own versions independently.
export const karakeepImage = "ghcr.io/karakeep-app/karakeep:0.32.0";
export const meilisearchImage = "getmeili/meilisearch:v1.11.3";
export const chromeImage = "gcr.io/zenika-hub/alpine-chrome:124";

export function configureKarakeep(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config("selfhosted");
  const nextAuthSecret = config.requireSecret("karakeepNextAuthSecret");
  const meiliMasterKey = config.requireSecret("karakeepMeiliMasterKey");
  const karakeepOAuthSecret = config.requireSecret("karakeep-secret");

  // ---------------------------------------------------------------------------
  // Meilisearch — full-text search engine required by Karakeep for indexing
  // bookmarks. It must start before the main application.
  // ---------------------------------------------------------------------------

  const meiliPvc = createPVC({
    name: "karakeep-meili-pvc",
    namespace,
    size: "5Gi",
    dependencies,
  });

  const meiliSecret = new k8s.core.v1.Secret("karakeep-meili-secrets", {
    metadata: {
      name: "karakeep-meili-secrets",
      namespace,
    },
    stringData: {
      MEILI_MASTER_KEY: meiliMasterKey,
    },
  }, { dependsOn: dependencies });

  const meiliDeployment = new k8s.apps.v1.Deployment("karakeep-meilisearch", {
    metadata: {
      name: "karakeep-meilisearch",
      namespace,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: { app: "karakeep-meilisearch" },
      },
      template: {
        metadata: {
          labels: { app: "karakeep-meilisearch" },
        },
        spec: {
          containers: [{
            name: "meilisearch",
            image: meilisearchImage,
            ports: [{ containerPort: 7700, name: "http" }],
            envFrom: [{ secretRef: { name: meiliSecret.metadata.name } }],
            env: [
              // Disabling analytics avoids external data egress from the homelab.
              { name: "MEILI_NO_ANALYTICS", value: "true" },
            ],
            volumeMounts: [{
              name: "meili-data",
              mountPath: "/meili_data",
            }],
          }],
          volumes: [{
            name: "meili-data",
            persistentVolumeClaim: { claimName: meiliPvc.metadata.name },
          }],
        },
      },
    },
  }, { dependsOn: [meiliPvc, meiliSecret] });

  const meiliService = new k8s.core.v1.Service("karakeep-meilisearch", {
    metadata: {
      name: "karakeep-meilisearch",
      namespace,
    },
    spec: {
      ports: [{ port: 7700, targetPort: 7700, protocol: "TCP", name: "http" }],
      selector: { app: "karakeep-meilisearch" },
    },
  }, { dependsOn: meiliDeployment });

  // NetworkPolicy restricting Meilisearch ingress to Karakeep pods only.
  // Meilisearch does not need to be reachable from Traefik or other services.
  const meiliNetworkPolicy = new k8s.networking.v1.NetworkPolicy("karakeep-allow-meilisearch-ingress", {
    metadata: {
      name: "karakeep-allow-meilisearch-ingress",
      namespace,
    },
    spec: {
      podSelector: {
        matchLabels: { app: "karakeep-meilisearch" },
      },
      ingress: [{
        from: [{
          podSelector: {
            matchLabels: { [Labels.Network.AllowKarakeepMeili]: "true" },
          },
        }],
        ports: [{ port: 7700 }],
      }],
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: meiliService });

  // ---------------------------------------------------------------------------
  // Chrome — headless browser used by Karakeep to crawl and archive linked
  // pages. It is stateless and does not require persistent storage.
  // ---------------------------------------------------------------------------

  const chromeDeployment = new k8s.apps.v1.Deployment("karakeep-chrome", {
    metadata: {
      name: "karakeep-chrome",
      namespace,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: { app: "karakeep-chrome" },
      },
      template: {
        metadata: {
          labels: { app: "karakeep-chrome" },
        },
        spec: {
          containers: [{
            name: "chrome",
            image: chromeImage,
            // These flags are required for running Chromium headlessly inside a
            // container without a real display or GPU.
            args: [
              "--no-sandbox",
              "--disable-gpu",
              "--disable-dev-shm-usage",
              "--remote-debugging-address=0.0.0.0",
              "--remote-debugging-port=9222",
              "--hide-scrollbars",
            ],
            ports: [{ containerPort: 9222, name: "devtools" }],
          }],
        },
      },
    },
  }, { dependsOn: dependencies });

  const chromeService = new k8s.core.v1.Service("karakeep-chrome", {
    metadata: {
      name: "karakeep-chrome",
      namespace,
    },
    spec: {
      ports: [{ port: 9222, targetPort: 9222, protocol: "TCP", name: "devtools" }],
      selector: { app: "karakeep-chrome" },
    },
  }, { dependsOn: chromeDeployment });

  // NetworkPolicy restricting Chrome DevTools protocol ingress to Karakeep
  // pods only — the remote debugging port must not be reachable from the network.
  const chromeNetworkPolicy = new k8s.networking.v1.NetworkPolicy("karakeep-allow-chrome-ingress", {
    metadata: {
      name: "karakeep-allow-chrome-ingress",
      namespace,
    },
    spec: {
      podSelector: {
        matchLabels: { app: "karakeep-chrome" },
      },
      ingress: [{
        from: [{
          podSelector: {
            matchLabels: { [Labels.Network.AllowKarakeepChrome]: "true" },
          },
        }],
        ports: [{ port: 9222 }],
      }],
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: chromeService });

  // ---------------------------------------------------------------------------
  // Karakeep — main application with bookmark storage.
  // ---------------------------------------------------------------------------

  const app = createSelfhostedApp({
    name: "karakeep",
    namespace,
    image: karakeepImage,
    containerPort: 3000,
    exposeType: "public",
    host: "karakeep.gdario.dev",
    labels: {
      [Labels.Network.AllowKarakeepMeili]: "true",
      [Labels.Network.AllowKarakeepChrome]: "true",
      [Labels.Network.AllowAuthentik]: "true",
    },
    secrets: {
      NEXTAUTH_SECRET: nextAuthSecret,
      MEILI_MASTER_KEY: meiliMasterKey,
      OAUTH_CLIENT_SECRET: karakeepOAuthSecret,
    },
    env: [
      {
        name: "NEXTAUTH_URL",
        value: "https://karakeep.gdario.dev",
      },
      {
        name: "MEILI_ADDR",
        value: pulumi.interpolate`http://${meiliService.metadata.name}.${namespace}.svc.cluster.local:7700`,
      },
      {
        name: "BROWSER_WEB_URL",
        value: pulumi.interpolate`http://${chromeService.metadata.name}.${namespace}.svc.cluster.local:9222`,
      },
      { name: "DATA_DIR", value: "/data" },
      // OIDC integration with the cluster-wide Authentik instance.
      { name: "OAUTH_CLIENT_ID", value: "karakeep-client-id" },
      {
        name: "OAUTH_WELLKNOWN_URL",
        value: "https://auth.gdario.dev/application/o/karakeep/.well-known/openid-configuration",
      },
      { name: "OAUTH_PROVIDER_NAME", value: "authentik" },
      // Required to link the Authentik user's email to an existing Karakeep account
      // instead of creating a duplicate on first SSO login.
      { name: "OAUTH_ALLOW_DANGEROUS_EMAIL_ACCOUNT_LINKING", value: "true" },
      // Disable local sign-in form and signups, auto-redirecting to Authentik OIDC
      { name: "DISABLE_PASSWORD_AUTH", value: "true" },
      { name: "DISABLE_SIGNUPS", value: "true" },
      { name: "OAUTH_AUTO_REDIRECT", value: "true" },
      // Optional: Path to JSON cookie file for the headless browser to bypass login walls
      { name: "BROWSER_COOKIE_PATH", value: "/data/cookies.json" },
    ],
    volumes: [{
      name: "karakeep-data",
      mountPath: "/data",
      size: "10Gi",
      pvcName: "karakeep-data-pvc",
    }],
    dependencies: [...dependencies, meiliService, chromeService],
  });

  const dataBackup = createBackupJob({
    appName: "karakeep",
    namespace,
    source: {
      type: "pvc",
      pvcName: "karakeep-data-pvc",
      mountPath: "/data",
    },
    dependencies: [...dependencies, app.deployment],
  });

  const meiliBackup = createBackupJob({
    appName: "karakeep-meili",
    namespace,
    source: {
      type: "pvc",
      pvcName: "karakeep-meili-pvc",
      mountPath: "/meili_data",
    },
    dependencies: [...dependencies, meiliDeployment],
  });

  return {
    ...app,
    meiliDeployment,
    meiliService,
    meiliNetworkPolicy,
    chromeDeployment,
    chromeService,
    chromeNetworkPolicy,
    dataBackup,
    meiliBackup,
  };
}
