import { hermesIdentity } from "./identity";
import * as pulumi from "@pulumi/pulumi";
import { AppConfig, AppSecrets, AppSettings } from "../../../library/app-settings";
import { oidcClientSecret, oidcIssuer } from "../../../library/oidc-app";

export class HermesAgentSettings implements AppSettings {
  public readonly config: AppConfig;
  public readonly secrets: AppSecrets;

  constructor(users: pulumi.Output<string>[], config = new pulumi.Config("selfhosted"), agentsConfig = new pulumi.Config("agents")) {
    const clientSecret = oidcClientSecret(hermesIdentity, config);
    this.config = {
      "HERMES_DASHBOARD": "1",
      "HERMES_DASHBOARD_PUBLIC_URL": hermesIdentity.url,
      "HERMES_DASHBOARD_OIDC_ISSUER": oidcIssuer(hermesIdentity),
      "HERMES_DASHBOARD_OIDC_CLIENT_ID": hermesIdentity.clientId,
      "HERMES_DASHBOARD_OIDC_SCOPES": hermesIdentity.scopes.join(" "),
      "API_SERVER_ENABLED": "true",
      "API_SERVER_HOST": "0.0.0.0",
      "API_SERVER_CORS_ORIGINS": hermesIdentity.url,
      "CUSTOM_BASE_URL": "http://litellm.infrastructure.svc.cluster.local/v1",
      "PULUMI_BACKEND_URL": "https://api.pulumi.com",
      "DOCKER_HOST": "tcp://localhost:2375",
    };
    this.secrets = {
      "TELEGRAM_ALLOWED_USERS": pulumi.all(users).apply(chats => chats.join(",")),
      "CUSTOM_API_KEY": config.requireSecret("hermesLitellmApiKey"),
      "DEEPSEEK_API_KEY": config.requireSecret("deepseekApiKey"),
      "TELEGRAM_BOT_TOKEN": config.requireSecret("telegramBotToken"),
      "API_SERVER_KEY": clientSecret,
      "HERMES_DASHBOARD_OIDC_CLIENT_SECRET": clientSecret,
      "PULUMI_CONFIG_PASSPHRASE": agentsConfig.requireSecret("pulumiPassphrase"),
      "PULUMI_ACCESS_TOKEN": agentsConfig.requireSecret("pulumiAccessToken"),
    };
  }
}
