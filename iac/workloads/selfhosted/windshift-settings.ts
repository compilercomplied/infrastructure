import * as pulumi from "@pulumi/pulumi";
import { AppConfig, AppSecrets, AppSettings } from "../../library/app-settings";

export class WindshiftSettings implements AppSettings {
  public readonly config: AppConfig = {
    "BASE_URL": "https://projects.gdario.dev",
    "WEBAUTHN_RP_ID": "projects.gdario.dev",
    "USE_PROXY": "true",
    "ALLOWED_HOSTS": "projects.gdario.dev",
    "WINDSHIFT_MEMORY_LIMIT_MB": "512",
    "SESSION_IP_BINDING": "log",
    "LOG_FORMAT": "json",
  };
  public readonly secrets: AppSecrets;

  constructor(config = new pulumi.Config("selfhosted")) {
    this.secrets = {
      "SSO_SECRET": config.requireSecret("windshiftSecret"),
    };
  }
}

export const windshiftSettings = new WindshiftSettings();
