import { forgejoIdentity } from "./identity";
import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createPostgresBootstrap } from "../../../library/postgres-bootstrap";
import { SelfhostedApp } from "../../../library/selfhosted-component";
import { Labels } from "../../selfhosted/labels";
import { forgejoSettings } from "./settings";
import { configureRepositories } from "../repositories";

const bootstrapScriptContent = fs.readFileSync(path.join(__dirname, "scripts", "bootstrap.sh"), "utf8");

export function configureForgejo(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "forgejo";
  const image = "codeberg.org/forgejo/forgejo:16.0.5";

  const settings = forgejoSettings;

  const bootstrapConfigMap = new k8s.core.v1.ConfigMap(`${name}-bootstrap-scripts`, {
    metadata: {
      name: `${name}-bootstrap-scripts`,
      namespace,
    },
    data: {
      "bootstrap-forgejo.sh": bootstrapScriptContent,
    },
  }, { dependsOn: dependencies });

  const dbInitJob = createPostgresBootstrap({
    name,
    namespace,
    databasePassword: settings.databasePassword,
    adminPassword: settings.postgresMasterPassword,
    scriptPaths: [path.join(__dirname, "scripts", "postgres_bootstrap.sql")],
    dependencies,
  });
  
  // 3. Deployment and Ingress configuration using the selfhosted-app library
  const app = new SelfhostedApp(name, {
    namespace,
    image,
    endpoints: [{ name: "http", servicePort: 80, containerPort: 3000, ingress: { name: "forgejo", host: forgejoIdentity.host } }],
    labels: {
      [Labels.Network.AllowPostgres]: "true",
      [Labels.Network.AllowAuthentik]: "true",
      "auth.gdario.dev/oidc-scopes": "offline-access-v1",
    },
    settings,
    databases: [{
      type: "postgres",
      databaseName: name,
      host: "shared-postgres.shared-resources.svc.cluster.local",
      username: name,
      passwordSecret: settings.databasePassword,
    }],
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
      },
    ],
    command: ["/bin/bash", "/scripts/bootstrap-forgejo.sh"],
    strategy: {
      type: "Recreate",
      rollingUpdate: null,
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
    dependencies: [...dependencies, bootstrapConfigMap, dbInitJob],
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
              // Preserve the default-deny exception for the disabled runner so re-enabling it
              // after isolation and resource controls are in place does not require a policy gap.
              podSelector: {
                matchLabels: {
                  app: "forgejo-android-runner",
                },
              },
            },
            {
              podSelector: {
                matchLabels: {
                  app: "hermes-agent",
                },
              },
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "agent-sidekicks" },
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

  const repositories = configureRepositories([app.deployment]);

  return {
    deployment: app.deployment,
    sshService,
    sshPolicy,
    internalHttpPolicy,

    runnerSecret: settings.secrets["RUNNER_SECRET"],
    androidRunnerSecret: settings.secrets["ANDROID_RUNNER_SECRET"],
    repositories,
  };
}
