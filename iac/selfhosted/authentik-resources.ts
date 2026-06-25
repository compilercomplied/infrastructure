import * as authentik from "@pulumi/authentik";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { createAuthentikOpenId } from "../library/authentik";
import { getAuthorizedUsers, getGroupDefinitions } from "./users";
import { Labels } from "./labels";

export function configureAuthentikResources(
  namespace: pulumi.Input<string>
) {
  const selfhostedConfig = new pulumi.Config("selfhosted");
  const tandooriSecret = selfhostedConfig.requireSecret("tandoori-secret");

  // Load the central user directory configuration.
  const users = getAuthorizedUsers();

  // Provision users centrally in Authentik. Existing users in the database will be
  // matched by username/email via the Authentik provider.
  const authentikUsers = users.map(u => new authentik.User(u.name, {
    username: u.name,
    name: u.name,
    email: u.email,
    isActive: true,
  }));

  // Create a mapping of username to their respective Authentik ID Output.
  // Using a reducer map makes resolving members by username simple and DRY.
  const userIdMap = users.reduce((acc, u, i) => {
    acc[u.name] = authentikUsers[i].id.apply(id => parseInt(id));
    return acc;
  }, {} as Record<string, pulumi.Output<number>>);

  // Retrieve central group mappings and dynamically provision the Authentik groups.
  // This loop handles hermes-users, grafana-admins, and any future groups automatically.
  const groupDefs = getGroupDefinitions(users.map(u => u.name));
  const groups = groupDefs.reduce((acc, gd) => {
    const group = new authentik.Group(gd.name, {
      name: gd.name,
      users: pulumi.all(gd.members.map(m => userIdMap[m])),
    });
    acc[gd.name] = group;
    return acc;
  }, {} as Record<string, authentik.Group>);

  const tandoor = createAuthentikOpenId({
    name: "Tandoor Recipes",
    slug: "tandoor-recipes",
    clientId: "tandoor-recipes-client-id",
    clientSecret: tandooriSecret,
    redirectUris: [
      "https://recipes.gdario.dev/accounts/oidc/authentik/login/callback/",
    ],
    launchUrl: "https://recipes.gdario.dev",
  });

  const googleClientId = selfhostedConfig.require("googleClientId");
  const googleClientSecret = selfhostedConfig.requireSecret("googleClientSecret");

  const googleSource = new authentik.SourceOauth("google-source", {
    name: "Google",
    slug: "google",
    providerType: "google",
    consumerKey: googleClientId,
    consumerSecret: googleClientSecret,
    // Provide URLs explicitly to prevent Pulumi diffs on every run
    accessTokenUrl: "https://oauth2.googleapis.com/token",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oidcJwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    profileUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    // This is a manual hack that should have been automated through the
    // authentik pulumi provider.
    authenticationFlow: "a7c56c41-379d-417c-9885-f0d55e174317",
    // We set enrollmentFlow to an empty string to clear any existing registration
    // flow and prevent self-service signup via Google OAuth.
    enrollmentFlow: "",
    userMatchingMode: "email_link",
  });

  const linkwardenSecret = selfhostedConfig.requireSecret("linkwarden-secret");

  const linkwarden = createAuthentikOpenId({
    name: "Linkwarden",
    slug: "linkwarden",
    clientId: "linkwarden-client-id",
    clientSecret: linkwardenSecret,
    redirectUris: [
      "https://linkwarden.gdario.dev/api/v1/auth/callback/authentik",
    ],
    launchUrl: "https://linkwarden.gdario.dev",
  });

  const grafanaSecret = selfhostedConfig.requireSecret("grafana-secret");

  const grafana = createAuthentikOpenId({
    name: "Grafana",
    slug: "grafana",
    clientId: "grafana-client-id",
    clientSecret: grafanaSecret,
    redirectUris: [
      "https://grafana.gdario.dev/login/generic_oauth",
    ],
    launchUrl: "https://grafana.gdario.dev",
  });

  const grimmorySecret = selfhostedConfig.requireSecret("grimmory-secret");

  const grimmory = createAuthentikOpenId({
    name: "Grimmory",
    slug: "grimmory",
    clientId: "grimmory-client-id",
    clientSecret: grimmorySecret,
    redirectUris: [
      "https://grimmory.gdario.dev/oauth2-callback",
    ],
    launchUrl: "https://grimmory.gdario.dev",
  });

  const syncthingProvider = new authentik.ProviderProxy("syncthing", {
    name: "Syncthing SSO",
    externalHost: "https://syncthing.gdario.dev",
    mode: "forward_single",
    authorizationFlow: "9faae557-fad6-4f95-876c-545adc95b3e4",
    invalidationFlow: "12830a53-f573-488d-bdc2-f12ddc59c0a7",
    // Explicitly define default fields to eliminate perpetual diff bugs in the Authentik Pulumi provider.
    interceptHeaderAuth: true,
    skipPathRegex: "^$",
    basicAuthEnabled: false,
    cookieDomain: "",
    internalHost: "",
    internalHostSslValidation: true,
    accessTokenValidity: "minutes=10",
    refreshTokenValidity: "days=30",
  });

  const syncthingApp = new authentik.Application("syncthing", {
    name: "Syncthing",
    slug: "syncthing",
    protocolProvider: syncthingProvider.id.apply(id => parseInt(id)),
    metaLaunchUrl: "https://syncthing.gdario.dev",
    metaPublisher: "GDario Labs",
  });

  const embeddedOutpost = authentik.getOutpostOutput({ name: "authentik Embedded Outpost" });
  new authentik.OutpostProviderAttachment("syncthing-outpost-attachment", {
    outpost: embeddedOutpost.apply(o => o.id || ""),
    protocolProvider: syncthingProvider.id.apply(id => parseInt(id)),
  });

  // The Pulumi Authentik provider (based on TF provider v2026.2.0) does not support the
  // grant_types field introduced in Authentik 2026.5.x, causing new providers to default to
  // empty grant types and block OIDC flows. This Kubernetes Job automatically runs a Django
  // Python snippet to patch the database post-provisioning.
  const scriptContent = fs.readFileSync(
    path.join(__dirname, "../maintenance/scripts/patch-grant-types.py"),
    "utf-8"
  );
  const patchScriptConfigMap = new k8s.core.v1.ConfigMap("patch-grant-types-script", {
    metadata: {
      namespace: namespace,
    },
    data: {
      "patch.py": scriptContent,
    },
  });

  // Hashing the provider IDs forces the Job to be replaced and re-run (via replaceOnChanges and
  // deleteBeforeReplace) whenever OIDC providers are created, modified, or replaced in Pulumi,
  // ensuring the database is always in sync with new program definitions.
  const providersHash = pulumi.all([
    tandoor.provider.id,
    linkwarden.provider.id,
    grafana.provider.id,
    grimmory.provider.id,
  ]).apply(ids => {
    return crypto.createHash("sha256").update(ids.join(",")).digest("hex");
  });

  const patchJob = new k8s.batch.v1.Job("patch-grant-types", {
    metadata: {
      namespace: namespace,
      annotations: {
        "providers-hash": providersHash,
      },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            "providers-hash": providersHash,
          },
          labels: {
            [Labels.Network.AllowPostgres]: "true",
          },
        },
        spec: {
          restartPolicy: "Never",
          containers: [
            {
              name: "patch",
              image: "ghcr.io/goauthentik/server:2026.5.2",
              command: ["/ak-root/.venv/bin/python", "/scripts/patch.py"],
               env: [
                { name: "PYTHONPATH", value: "/" },
                { name: "AUTHENTIK_REDIS__HOST", value: "authentik-redis" },
                { name: "AUTHENTIK_POSTGRESQL__HOST", value: "shared-postgres.selfhosted.svc.cluster.local" },
                { name: "AUTHENTIK_POSTGRESQL__USER", value: "authentik" },
                { name: "AUTHENTIK_POSTGRESQL__NAME", value: "authentik" },
                { name: "AUTHENTIK_POSTGRESQL__PORT", value: "5432" },
                { name: "AUTHENTIK_ERROR_REPORTING__ENABLED", value: "false" },
                {
                  name: "AUTHENTIK_SECRET_KEY",
                  valueFrom: {
                    secretKeyRef: {
                      name: "authentik-secrets",
                      key: "AUTHENTIK_SECRET_KEY",
                    },
                  },
                },
                {
                  name: "AUTHENTIK_POSTGRESQL__PASSWORD",
                  valueFrom: {
                    secretKeyRef: {
                      name: "authentik-secrets",
                      key: "AUTHENTIK_POSTGRESQL__PASSWORD",
                    },
                  },
                },
                {
                  name: "AUTHENTIK_REDIS__PASSWORD",
                  valueFrom: {
                    secretKeyRef: {
                      name: "authentik-secrets",
                      key: "AUTHENTIK_REDIS__PASSWORD",
                    },
                  },
                },
              ],
              volumeMounts: [
                {
                  name: "scripts",
                  mountPath: "/scripts",
                },
              ],
            },
          ],
          volumes: [
            {
              name: "scripts",
              configMap: {
                name: patchScriptConfigMap.metadata.name,
              },
            },
          ],
        },
      },
    },
  }, {
    dependsOn: [
      tandoor.provider,
      linkwarden.provider,
      grafana.provider,
      grimmory.provider,
    ],
    replaceOnChanges: ["metadata.annotations"],
    deleteBeforeReplace: true,
  });

  return {
    tandoorProviderId: tandoor.provider.id,
    tandoorAppSlug: tandoor.app.slug,
    googleSourceId: googleSource.id,
    linkwardenProviderId: linkwarden.provider.id,
    linkwardenAppSlug: linkwarden.app.slug,
    grimmoryProviderId: grimmory.provider.id,
    grimmoryAppSlug: grimmory.app.slug,
    hermesGroupId: groups["hermes-users"].id,
    grafanaAdminsGroupId: groups["grafana-admins"].id,
    grafanaProviderId: grafana.provider.id,
    grafanaAppSlug: grafana.app.slug,
    syncthingProviderId: syncthingProvider.id,
    syncthingAppSlug: syncthingApp.slug,
  };
}
