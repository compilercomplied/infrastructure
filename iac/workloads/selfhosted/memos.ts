import { memosIdentity } from "./memos-identity";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp } from "../../library/selfhosted-component";
import { postgresClientImage } from "../../platform/shared-resources/shared-postgres";
import { Labels } from "./labels";
import { memosSettings } from "./memos-settings";
import { authentikAuthorizeUrl, authentikTokenUrl, authentikUserInfoUrl, oidcClientSecret } from "../../library/oidc-app";

// The shared PostgreSQL instance only runs its init scripts on a fresh data
// directory, so an existing cluster needs an idempotent Job to create this
// database and role. Reusing the generic script keeps every app's bootstrap
// identical.
const dbInitScriptContent = fs.readFileSync(path.join(__dirname, "../../operations/maintenance/scripts/init-forgejo-db.sh"), "utf8");

export function configureMemos(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "memos";
  const config = new pulumi.Config("selfhosted");
  const clientSecretOutput = oidcClientSecret(memosIdentity, config);

  // Memos configures SSO, its sign-in policy, and its access mode only through
  // JSON files mounted at /etc/secrets: there is no matching environment
  // variable. Declaring those files here is what keeps the OIDC contract
  // declarative — the client id, callback URL, and scopes have to match the
  // Authentik blueprint — and keeps them out of the instance database, where
  // they would otherwise be editable state.
  //
  // The identity key is `sub`: it survives an Authentik username rename, unlike
  // preferred_username. Users can still rename their Memos account afterwards.
  const identityProviderFile = clientSecretOutput.apply(clientSecret => JSON.stringify({
    uid: "authentik",
    name: "Authentik",
    type: "OAUTH2",
    config: {
      oauth2Config: {
        clientId: memosIdentity.clientId,
        clientSecret,
        authUrl: authentikAuthorizeUrl,
        tokenUrl: authentikTokenUrl,
        userInfoUrl: authentikUserInfoUrl,
        scopes: memosIdentity.scopes,
        fieldMapping: {
          identifier: "sub",
          displayName: "name",
          email: "email",
          avatarUrl: "picture",
        },
      },
    },
  }));

  // Authentik is the only sign-in path for regular users; the one exception is
  // the first-run owner account, which Memos always allows to be created with a
  // password and documents as the recovery path. Registration itself stays open
  // because that is the switch that lets first-time SSO users get an account.
  const generalSettingFile = JSON.stringify({
    key: "GENERAL",
    generalSetting: {
      disallowUserRegistration: false,
      disallowPasswordAuth: true,
    },
  });

  // MEMOS_INSTANCE_URL is set, which by itself leaves the instance in its public
  // access mode (an anonymous Explore feed). These are private notes, so the
  // access mode is pinned instead.
  const accessSettingFile = JSON.stringify({
    key: "ACCESS",
    accessSetting: {
      accessMode: "INSTANCE_ACCESS_MODE_PRIVATE",
    },
  });

  const deploymentConfigFiles: Record<string, pulumi.Input<string>> = {
    "memos-idp-authentik.json": identityProviderFile,
    "memos-instance-setting-general.json": generalSettingFile,
    "memos-instance-setting-access.json": accessSettingFile,
  };

  const deploymentConfigSecret = new k8s.core.v1.Secret(`${name}-deployment-config`, {
    metadata: {
      name: `${name}-deployment-config`,
      namespace,
    },
    stringData: deploymentConfigFiles,
  }, { dependsOn: dependencies });

  // Memos reads these files once per process, so a changed file has to replace
  // the Pods rather than wait for the next unrelated rollout.
  const deploymentConfigChecksum = pulumi.all(Object.values(deploymentConfigFiles)).apply(contents =>
    crypto.createHash("sha256").update(contents.join("\n")).digest("hex"));

  const dbScriptsConfigMap = new k8s.core.v1.ConfigMap(`${name}-db-init-scripts`, {
    metadata: {
      name: `${name}-db-init-scripts`,
      namespace,
    },
    data: {
      "init-forgejo-db.sh": dbInitScriptContent,
    },
  }, { dependsOn: dependencies });

  const dbInitSecrets = new k8s.core.v1.Secret(`${name}-secrets-dbinit`, {
    metadata: {
      name: `${name}-secrets-dbinit`,
      namespace,
    },
    stringData: {
      "DB_PASSWORD": memosSettings.databasePassword,
      "ADMIN_PASSWORD": config.requireSecret("postgresPassword"),
    },
  }, { dependsOn: dependencies });

  const dbInitHash = pulumi.all([memosSettings.databasePassword, config.requireSecret("postgresPassword"), dbInitScriptContent]).apply(([dbPassword, adminPassword, script]) => {
    return crypto.createHash("sha256").update(dbPassword + adminPassword + script).digest("hex");
  });

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
              { name: "DB_HOST", value: "shared-postgres.shared-resources.svc.cluster.local" },
              { name: "DB_NAME", value: name },
              { name: "DB_USER", value: name },
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
    dependsOn: [dbScriptsConfigMap, dbInitSecrets, ...dependencies],
    replaceOnChanges: ["metadata.annotations"],
    deleteBeforeReplace: true,
  });

  const app = new SelfhostedApp(name, {
    namespace,
    image: "neosmemo/memos:0.31.0",
    endpoints: [{
      name: "http",
      servicePort: 80,
      containerPort: 5230,
      ingress: { name: "memos", host: memosIdentity.host },
      healthCheck: { protocol: "http", path: "/healthz" },
    }],
    labels: {
      [Labels.Network.AllowPostgres]: "true",
      [Labels.Network.AllowAuthentik]: "true",
    },
    settings: memosSettings,
    databases: [{
      type: "postgres",
      databaseName: name,
      host: "shared-postgres.shared-resources.svc.cluster.local",
      username: name,
      passwordSecret: memosSettings.databasePassword,
    }],
    volumes: [{
      name: "data",
      mountPath: "/var/opt/memos",
      size: "5Gi",
    }],
    // Memos reads deployment-managed configuration as direct children of
    // /etc/secrets; the client secret lives in that file, so the directory is
    // backed by a Secret rather than a ConfigMap.
    additionalVolumes: [{
      name: "deployment-config",
      secret: {
        secretName: deploymentConfigSecret.metadata.name,
      },
    }],
    additionalVolumeMounts: [{
      name: "deployment-config",
      mountPath: "/etc/secrets",
      readOnly: true,
    }],
    podAnnotations: {
      "homelab.gdario.dev/deployment-config-checksum": deploymentConfigChecksum,
    },
    readinessProbe: {
      httpGet: { path: "/healthz", port: 5230 },
      initialDelaySeconds: 5,
      periodSeconds: 10,
      failureThreshold: 3,
    },
    livenessProbe: {
      httpGet: { path: "/healthz", port: 5230 },
      initialDelaySeconds: 30,
      periodSeconds: 30,
      failureThreshold: 3,
    },
    resources: {
      requests: { cpu: "25m", memory: "128Mi" },
      limits: { cpu: "500m", memory: "512Mi" },
    },
    dependencies: [...dependencies, deploymentConfigSecret, dbInitSecrets, dbInitJob],
  });

  return {
    deployment: app.deployment,
  };
}
