import * as crypto from "crypto";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp } from "../../library/selfhosted-component";
import { Labels } from "./labels";
import { windshiftSettings } from "./windshift-settings";

const windshiftImage = "ghcr.io/windshiftapp/windshift@sha256:98292b54b55ff1414bc315d9cd852edbe452f14f4fad436073166cebfa921a23";
const curlImage = "curlimages/curl@sha256:935d9100e9ba842cdb060de42472c7ca90cfe9a7c96e4dacb55e79e560b3ff40";

const bootstrapScript = `set -eu
api=http://windshift.selfhosted.svc.cluster.local
origin=https://projects.gdario.dev
cookie=/tmp/windshift-cookie

until curl --fail --silent --show-error "$api/readyz" >/dev/null; do sleep 2; done

status=$(curl --fail --silent --show-error "$api/api/setup/status")
case "$status" in
  *'"setup_completed":true'*) ;;
  *)
    setup=$(printf '{"admin_user":{"email":"%s","username":"gdario","first_name":"GDario","last_name":"Admin","language":"en","password":"%s"},"module_settings":{"time_tracking_enabled":true,"test_management_enabled":true,"workspace_managed_agents":false}}' "$BOOTSTRAP_ADMIN_EMAIL" "$BOOTSTRAP_ADMIN_PASSWORD")
    curl --fail --silent --show-error --cookie-jar "$cookie" \\
      --header 'Content-Type: application/json' --header "Origin: $origin" \\
      --data "$setup" "$api/api/setup/complete" >/dev/null
    ;;
esac

sso=$(curl --fail --silent --show-error "$api/api/sso/status")
case "$sso" in
  *'"provider_slug":"authentik"'*) exit 0 ;;
esac

login=$(printf '{"email_or_username":"%s","password":"%s","remember_me":false}' "$BOOTSTRAP_ADMIN_EMAIL" "$BOOTSTRAP_ADMIN_PASSWORD")
curl --fail --silent --show-error --cookie-jar "$cookie" \\
  --header 'Content-Type: application/json' --header "Origin: $origin" \\
  --data "$login" "$api/api/auth/login" >/dev/null

provider=$(printf '{"slug":"authentik","name":"Authentik","provider_type":"oidc","enabled":true,"is_default":true,"issuer_url":"https://auth.gdario.dev/application/o/windshift/","client_id":"windshift-client-id","client_secret":"%s","scopes":"openid email profile","auto_provision_users":true,"require_verified_email":true,"attribute_mapping":"{\\"email\\":\\"email\\",\\"name\\":\\"name\\",\\"given_name\\":\\"given_name\\",\\"family_name\\":\\"family_name\\",\\"username\\":\\"preferred_username\\",\\"email_verified\\":\\"email_verified\\"}"}' "$OIDC_CLIENT_SECRET")
curl --fail --silent --show-error --cookie "$cookie" \\
  --header 'Content-Type: application/json' --header "Origin: $origin" \\
  --data "$provider" "$api/api/sso/providers" >/dev/null
`;

export function configureWindshift(namespace: pulumi.Input<string>, dependencies: pulumi.Resource[] = []) {
  const name = "windshift";
  const config = new pulumi.Config("selfhosted");
  const bootstrapConfig = {
    "BOOTSTRAP_ADMIN_EMAIL": config.requireSecret("user-gdario-email"),
    "BOOTSTRAP_ADMIN_PASSWORD": config.requireSecret("windshiftBootstrapPassword"),
    "OIDC_CLIENT_SECRET": config.requireSecret("windshiftOidcClientSecret"),
  };
  const bootstrapSecret = new k8s.core.v1.Secret(`${name}-bootstrap`, {
    metadata: { name: `${name}-bootstrap`, namespace },
    stringData: bootstrapConfig,
  }, { dependsOn: dependencies });
  const bootstrapChecksum = pulumi.all(Object.values(bootstrapConfig)).apply(values =>
    crypto.createHash("sha256").update(values.join("\n") + bootstrapScript).digest("hex"));

  const app = new SelfhostedApp(name, {
    namespace,
    image: windshiftImage,
    endpoints: [{
      name: "http",
      servicePort: 80,
      containerPort: 8080,
      ingress: { name, host: "projects.gdario.dev" },
      healthCheck: { protocol: "http", path: "/readyz" },
      allowIngressFrom: [{ podSelector: { app: `${name}-bootstrap` } }],
    }],
    labels: { [Labels.Network.AllowAuthentik]: "true" },
    settings: windshiftSettings,
    volumes: [{ name: "data", mountPath: "/data", size: "5Gi" }],
    additionalVolumes: [{ name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } }],
    additionalVolumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
    podSecurityContext: { fsGroup: 65534, fsGroupChangePolicy: "OnRootMismatch" },
    readinessProbe: { httpGet: { path: "/readyz", port: 8080 }, initialDelaySeconds: 10, periodSeconds: 10, failureThreshold: 6 },
    livenessProbe: { httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 30, periodSeconds: 30, failureThreshold: 3 },
    resources: { requests: { cpu: "100m", memory: "512Mi" }, limits: { cpu: "1", memory: "768Mi" } },
    dependencies: [...dependencies, bootstrapSecret],
  });

  const bootstrap = new k8s.batch.v1.Job(`${name}-bootstrap`, {
    metadata: { name: `${name}-bootstrap`, namespace, annotations: { "bootstrap-checksum": bootstrapChecksum } },
    spec: {
      backoffLimit: 6,
      template: {
        metadata: { labels: { app: `${name}-bootstrap` }, annotations: { "bootstrap-checksum": bootstrapChecksum } },
        spec: {
          restartPolicy: "OnFailure",
          containers: [{
            name: "bootstrap",
            image: curlImage,
            command: ["sh", "-ec", bootstrapScript],
            env: Object.keys(bootstrapConfig).map(name => ({
              name,
              valueFrom: { secretKeyRef: { name: bootstrapSecret.metadata.name, key: name } },
            })),
          }],
        },
      },
    },
  }, { dependsOn: [app.deployment, app.service, bootstrapSecret], replaceOnChanges: ["metadata.annotations"], deleteBeforeReplace: true });

  return { deployment: app.deployment, bootstrap };
}
