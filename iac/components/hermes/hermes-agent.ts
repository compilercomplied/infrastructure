import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp } from "../../library/selfhosted-component";
import { Labels } from "../../selfhosted/labels";
import { getAuthorizedUsers } from "../../selfhosted/users";

export interface HermesAgentArgs {
  namespace: pulumi.Input<string>;
  dependencies?: pulumi.Resource[];
}

export class HermesAgent extends pulumi.ComponentResource {
  public readonly deployment: k8s.apps.v1.Deployment;
  public readonly service: k8s.core.v1.Service;
  public readonly ingress: k8s.networking.v1.Ingress;
  public readonly apiIngress: k8s.networking.v1.Ingress;
  public readonly dataBackup: k8s.batch.v1.CronJob;

  constructor(name: string, args: HermesAgentArgs, opts?: pulumi.ComponentResourceOptions) {
    super("custom:selfhosted:HermesAgent", name, {}, opts);

    const { namespace, dependencies = [] } = args;
    const config = new pulumi.Config("selfhosted");
    const agentsConfig = new pulumi.Config("agents");
    const users = getAuthorizedUsers();
    const oidcClientSecret = config.requireSecret("hermesSecret");

    const legacyParentAlias = { parent: pulumi.rootStackResource };
    const serviceAccount = new k8s.core.v1.ServiceAccount(`${name}-sa`, {
      metadata: { name: `${name}-sa`, namespace },
    }, { parent: this, aliases: [legacyParentAlias] });

    // Pulumi previews authorize server-side dry runs using the same Kubernetes verbs as an
    // update, so Hermes needs cluster-wide access even though it does not apply changes.
    const clusterRoleBinding = new k8s.rbac.v1.ClusterRoleBinding(`${name}-admin-binding`, {
      metadata: { name: `${name}-admin-binding` },
      subjects: [{ kind: "ServiceAccount", name: serviceAccount.metadata.name, namespace }],
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: "cluster-admin",
      },
    }, { parent: this, aliases: [legacyParentAlias] });

    const app = new SelfhostedApp(name, {
      namespace,
      image: "nousresearch/hermes-agent:latest",
      endpoints: [
        {
          name: "http",
          containerPort: 9119,
          servicePort: 80,
          ingress: { name, host: "hermes.gdario.dev" },
        },
        {
          name: "api",
          containerPort: 8642,
          servicePort: 8642,
          ingress: { name: `${name}-api`, host: "hermes-api.gdario.dev" },
        },
      ],
      config: {
        "TELEGRAM_ALLOWED_USERS": pulumi.all(users.map(user => user.telegramId)).apply(chats => chats.join(",")),
        "HERMES_DASHBOARD": "1",
        "HERMES_DASHBOARD_PUBLIC_URL": "https://hermes.gdario.dev",
        "HERMES_DASHBOARD_OIDC_ISSUER": "https://auth.gdario.dev/application/o/hermes/",
        "HERMES_DASHBOARD_OIDC_CLIENT_ID": "hermes-client-id",
        "HERMES_DASHBOARD_OIDC_SCOPES": "openid profile email offline_access",
        "API_SERVER_ENABLED": "true",
        "API_SERVER_HOST": "0.0.0.0",
        "API_SERVER_CORS_ORIGINS": "https://hermes.gdario.dev",
        "CUSTOM_BASE_URL": "http://litellm.infrastructure.svc.cluster.local/v1",
        "PULUMI_BACKEND_URL": "https://api.pulumi.com",
        "DOCKER_HOST": "tcp://localhost:2375",
      },
      secrets: {
        "CUSTOM_API_KEY": config.requireSecret("hermesLitellmApiKey"),
        "DEEPSEEK_API_KEY": config.requireSecret("deepseekApiKey"),
        "TELEGRAM_BOT_TOKEN": config.requireSecret("telegramBotToken"),
        "API_SERVER_KEY": oidcClientSecret,
        "HERMES_DASHBOARD_OIDC_CLIENT_SECRET": oidcClientSecret,
        "PULUMI_CONFIG_PASSPHRASE": agentsConfig.requireSecret("pulumiPassphrase"),
        "PULUMI_ACCESS_TOKEN": agentsConfig.requireSecret("pulumiAccessToken"),
      },
      labels: {
        [Labels.Network.AllowAuthentik]: "true",
      },
      args: ["gateway", "run"],
      strategy: { type: "RollingUpdate" },
      ipFamilyPolicy: "SingleStack",
      ipFamilies: ["IPv4"],
      serviceAccountName: serviceAccount.metadata.name,
      automountServiceAccountToken: false,
      runtimeClassName: "kata-qemu",
      resources: {
        limits: { memory: "6Gi" },
        requests: { memory: "2Gi" },
      },
      volumes: [{
        name: "data",
        mountPath: "/opt/data",
        size: "256Mi",
        pvcName: `${name}-pvc`,
      }],
      additionalContainers: [{
        name: "dind",
        image: "docker:26-dind",
        securityContext: { privileged: true },
        env: [{ name: "DOCKER_TLS_CERTDIR", value: "" }],
        volumeMounts: [{ name: "docker-graph-storage", mountPath: "/var/lib/docker" }],
      }],
      additionalVolumes: [
        { name: "docker-graph-storage", emptyDir: {} },
        {
          name: "kube-api-access",
          projected: {
            defaultMode: 0o644,
            sources: [
              { serviceAccountToken: { path: "token", expirationSeconds: 3600 } },
              { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } },
              { downwardAPI: { items: [{ path: "namespace", fieldRef: { fieldPath: "metadata.namespace" } }] } },
            ],
          },
        },
      ],
      additionalVolumeMounts: [{
        name: "kube-api-access",
        mountPath: "/var/run/secrets/kubernetes.io/serviceaccount",
        readOnly: true,
      }],
      dependencies: [...dependencies, serviceAccount, clusterRoleBinding],
      childAliases: [{ parent: this }],
    }, { parent: this });

    this.deployment = app.deployment;
    this.service = app.service;
    this.ingress = app.ingresses[0];
    this.apiIngress = app.ingresses[1];
    this.dataBackup = app.backupJobs[0];

    this.registerOutputs({
      deployment: this.deployment,
      service: this.service,
      ingress: this.ingress,
      apiIngress: this.apiIngress,
      dataBackup: this.dataBackup,
    });
  }
}
