import * as pulumi from "@pulumi/pulumi";
import { AppConfig, AppSecrets, AppSettings } from "../../library/app-settings";

export class HermesAgentSettings implements AppSettings {
  public readonly config: AppConfig;
  public readonly secrets: AppSecrets;

  constructor(users: pulumi.Output<string>[], config = new pulumi.Config("selfhosted"), agentsConfig = new pulumi.Config("agents")) {
    const oidcClientSecret = config.requireSecret("hermesSecret");
    this.config = {
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
    };
    this.secrets = {
      "TELEGRAM_ALLOWED_USERS": pulumi.all(users).apply(chats => chats.join(",")),
      "CUSTOM_API_KEY": config.requireSecret("hermesLitellmApiKey"),
      "DEEPSEEK_API_KEY": config.requireSecret("deepseekApiKey"),
      "TELEGRAM_BOT_TOKEN": config.requireSecret("telegramBotToken"),
      "API_SERVER_KEY": oidcClientSecret,
      "HERMES_DASHBOARD_OIDC_CLIENT_SECRET": oidcClientSecret,
      "PULUMI_CONFIG_PASSPHRASE": agentsConfig.requireSecret("pulumiPassphrase"),
      "PULUMI_ACCESS_TOKEN": agentsConfig.requireSecret("pulumiAccessToken"),
    };
  }
}
