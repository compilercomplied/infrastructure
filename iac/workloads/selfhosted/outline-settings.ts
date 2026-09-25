import * as pulumi from "@pulumi/pulumi";
import { AppConfig, AppSecrets, AppSettings } from "../../library/app-settings";

export class OutlineSettings implements AppSettings {
  public readonly config: AppConfig = {
    "NODE_ENV": "production",
    "PORT": "3000",
    "HOST": "::",
    "URL": "https://outline.gdario.dev",
    "FORCE_HTTPS": "false",
    "PGSSLMODE": "disable",
    "REDIS_URL": "redis://outline-redis.selfhosted.svc.cluster.local:80",
    "AWS_ACCESS_KEY_ID": "minioadmin",
    "AWS_REGION": "us-east-1",
    "AWS_S3_UPLOAD_BUCKET_URL": "http://outline-minio.selfhosted.svc.cluster.local:80",
    "AWS_S3_UPLOAD_BUCKET_NAME": "outline",
    "FILE_STORAGE_UPLOAD_MAX_SIZE": "26214400",
    "AWS_S3_FORCE_PATH_STYLE": "true",
    "AWS_S3_ACL": "private",
    "OIDC_CLIENT_ID": "outline-client-id",
    "OIDC_AUTH_URI": "https://auth.gdario.dev/application/o/authorize/",
    "OIDC_TOKEN_URI": "https://auth.gdario.dev/application/o/token/",
    "OIDC_USERINFO_URI": "https://auth.gdario.dev/application/o/userinfo/",
    "OIDC_USERNAME_CLAIM": "preferred_username",
    "OIDC_DISPLAY_NAME": "Authentik",
    "OIDC_SCOPES": "openid profile email offline_access",
  };
  public readonly secrets: AppSecrets;

  constructor(config = new pulumi.Config("selfhosted")) {
    const databasePassword = config.requireSecret("outlineDbPassword");

    this.secrets = {
      "SECRET_KEY": config.requireSecret("outlineSecretKey"),
      "UTILS_SECRET": config.requireSecret("outlineUtilsSecret"),
      "DATABASE_URL": pulumi.interpolate`postgres://outline:${databasePassword}@shared-postgres.shared-resources.svc.cluster.local:5432/outline`,
      "AWS_SECRET_ACCESS_KEY": config.requireSecret("outlineMinioPassword"),
      "OIDC_CLIENT_SECRET": config.requireSecret("outlineOidcClientSecret"),
    };
  }
}

export const outlineSettings = new OutlineSettings();

export const outlineRedisSettings: AppSettings = {
  config: {},
  secrets: {},
};

export class OutlineMinioSettings implements AppSettings {
  public readonly config: AppConfig = {
    "MINIO_ROOT_USER": "minioadmin",
  };
  public readonly secrets: AppSecrets;

  constructor(config = new pulumi.Config("selfhosted")) {
    this.secrets = {
      "MINIO_ROOT_PASSWORD": config.requireSecret("outlineMinioPassword"),
    };
  }
}

export const outlineMinioSettings = new OutlineMinioSettings();
