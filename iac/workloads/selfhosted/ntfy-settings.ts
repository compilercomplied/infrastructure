import * as pulumi from "@pulumi/pulumi";
import { AppConfig, AppSecrets, AppSettings } from "../../library/app-settings";

export class NtfySettings implements AppSettings {
  public readonly config: AppConfig = {
    "NTFY_BASE_URL": "https://notifications.gdario.dev",
    "NTFY_CACHE_FILE": "/var/lib/ntfy/cache.db",
    "NTFY_AUTH_FILE": "/var/lib/ntfy/auth.db",
    "NTFY_AUTH_DEFAULT_ACCESS": "deny-all",
    "NTFY_ENABLE_LOGIN": "true",
    "NTFY_REQUIRE_LOGIN": "true",
    "NTFY_BEHIND_PROXY": "true",
    // iOS wakeups transit ntfy.sh, but clients retrieve messages from this instance.
    "NTFY_UPSTREAM_BASE_URL": "https://ntfy.sh",
  };
  public readonly secrets: AppSecrets;

  constructor(config = new pulumi.Config("selfhosted")) {
    this.secrets = {
      "NTFY_AUTH_USERS": pulumi.interpolate`gdario:${config.requireSecret("ntfyAdminPasswordHash")}:admin`,
    };
  }
}

export const ntfySettings = new NtfySettings();
