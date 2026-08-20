import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp } from "../library/selfhosted-component";
import { Labels } from "./labels";

export function configureOutline(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "outline";
  const config = new pulumi.Config("selfhosted");

  const dbPassword = config.requireSecret("outlineDbPassword");
  const secretKey = config.requireSecret("outlineSecretKey");
  const utilsSecret = config.requireSecret("outlineUtilsSecret");
  const minioPassword = config.requireSecret("outlineMinioPassword");
  const oidcClientSecret = config.requireSecret("outlineOidcClientSecret");

  // Redis
  const redis = new SelfhostedApp(`${name}-redis`, {
    namespace,
    image: "redis:7-alpine",
    containerPort: 6379,
    exposeType: "private",
    allowIngressFrom: [{ podSelector: { app: name }, port: 6379 }],
    volumes: [
      {
        name: "redis-data",
        mountPath: "/data",
        size: "1Gi",
      }
    ],
    dependencies,
  });

  // MinIO
  const minio = new SelfhostedApp(`${name}-minio`, {
    namespace,
    image: "minio/minio:latest",
    containerPort: 9000,
    exposeType: "private",
    allowIngressFrom: [{ podSelector: { app: name }, port: 9000 }],
    args: ["server", "/data"],
    env: [
      { name: "MINIO_ROOT_USER", value: "minioadmin" },
      { name: "MINIO_ROOT_PASSWORD", value: minioPassword },
    ],
    volumes: [
      {
        name: "minio-data",
        mountPath: "/data",
        size: "10Gi",
      },
    ],
    dependencies,
  });

  // MinIO Setup Job
  const minioSetup = new k8s.batch.v1.Job(`${name}-minio-setup`, {
    metadata: { name: `${name}-minio-setup`, namespace },
    spec: {
      template: {
        spec: {
          containers: [{
            name: "mc",
            image: "minio/mc:latest",
            env: [
              { name: "MINIO_ROOT_PASSWORD", value: minioPassword }
            ],
            command: ["/bin/bash", "-c", `
              sleep 10;
              mc alias set myminio http://outline-minio.selfhosted.svc.cluster.local:80 minioadmin $MINIO_ROOT_PASSWORD;
              mc mb myminio/outline || true;
              mc anonymous set public myminio/outline;
            `]
          }],
          restartPolicy: "OnFailure"
        }
      }
    }
  }, { dependsOn: [minio.deployment] });

  // Outline Web App
  const outline = new SelfhostedApp(name, {
    namespace,
    image: "outlinewiki/outline:latest",
    containerPort: 3000,
    exposeType: "public",
    host: "outline.gdario.dev",
    ipFamilyPolicy: "SingleStack",
    ipFamilies: ["IPv6"],
    labels: {
      [Labels.Network.AllowAuthentik]: "true",
      [Labels.Network.AllowPostgres]: "true",
    },
    allowIngressFrom: [
      {
        podSelector: { app: "outline-mcp" },
        namespaceSelector: { "kubernetes.io/metadata.name": "agent-sidekicks" }
      },
    ],
    env: [
      { name: "NODE_ENV", value: "production" },
      { name: "PORT", value: "3000" },
      { name: "HOST", value: "::" },
      { name: "URL", value: "https://outline.gdario.dev" },
      { name: "FORCE_HTTPS", value: "false" },
      { name: "SECRET_KEY", value: secretKey },
      { name: "UTILS_SECRET", value: utilsSecret },
      { name: "DATABASE_URL", value: pulumi.interpolate`postgres://outline:${dbPassword}@shared-postgres.shared-resources.svc.cluster.local:5432/outline` },
      { name: "PGSSLMODE", value: "disable" },
      { name: "REDIS_URL", value: "redis://outline-redis.selfhosted.svc.cluster.local:80" },

      // Minio S3 Config
      { name: "AWS_ACCESS_KEY_ID", value: "minioadmin" },
      { name: "AWS_SECRET_ACCESS_KEY", value: minioPassword },
      { name: "AWS_REGION", value: "us-east-1" },
      { name: "AWS_S3_UPLOAD_BUCKET_URL", value: "http://outline-minio.selfhosted.svc.cluster.local:80" },
      { name: "AWS_S3_UPLOAD_BUCKET_NAME", value: "outline" },
      { name: "FILE_STORAGE_UPLOAD_MAX_SIZE", value: "26214400" },
      { name: "AWS_S3_FORCE_PATH_STYLE", value: "true" },
      { name: "AWS_S3_ACL", value: "private" },

      // OIDC Config
      { name: "OIDC_CLIENT_ID", value: "outline-client-id" },
      { name: "OIDC_CLIENT_SECRET", value: oidcClientSecret },
      { name: "OIDC_AUTH_URI", value: "https://auth.gdario.dev/application/o/authorize/" },
      { name: "OIDC_TOKEN_URI", value: "https://auth.gdario.dev/application/o/token/" },
      { name: "OIDC_USERINFO_URI", value: "https://auth.gdario.dev/application/o/userinfo/" },
      { name: "OIDC_USERNAME_CLAIM", value: "preferred_username" },
      { name: "OIDC_DISPLAY_NAME", value: "Authentik" },
      { name: "OIDC_SCOPES", value: "openid profile email" },
    ],
    dependencies: [minioSetup, redis.deployment, ...dependencies],
  });

  return {
    redis,
    minio,
    outline,
  };
}
