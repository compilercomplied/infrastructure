import * as crypto from "crypto";
import * as pulumi from "@pulumi/pulumi";
import { AppConfig, AppSecrets, AppSettings } from "../../library/app-settings";

export class ForgejoSettings implements AppSettings {
  public readonly config: AppConfig = {
    "FORGEJO__database__DB_TYPE": "postgres",
    "FORGEJO__database__HOST": "shared-postgres.shared-resources.svc.cluster.local:5432",
    "FORGEJO__database__NAME": "forgejo",
    "FORGEJO__database__USER": "forgejo",
    "FORGEJO__server__DOMAIN": "git.gdario.dev",
    "FORGEJO__server__SSH_DOMAIN": "git.gdario.dev",
    "FORGEJO__server__SSH_PORT": "2222",
    "FORGEJO__server__SSH_LISTEN_PORT": "22",
    "FORGEJO__server__ROOT_URL": "https://git.gdario.dev/",
    "FORGEJO__security__INSTALL_LOCK": "true",
    "FORGEJO__service__DISABLE_REGISTRATION": "true",
    "FORGEJO__service__ALLOW_ONLY_EXTERNAL_REGISTRATION": "false",
    "FORGEJO__service__ENABLE_BASIC_AUTHENTICATION": "false",
    "FORGEJO__openid__ENABLE_OPENID_SIGNIN": "false",
    "FORGEJO__oauth2_client__ENABLE_AUTO_REGISTRATION": "true",
    "FORGEJO__oauth2_client__ACCOUNT_LINKING": "auto",
    "FORGEJO__actions__ENABLED": "true",
    // This permits automation to create repositories and organizations without UI setup.
    "FORGEJO__repository__ENABLE_PUSH_CREATE_USER": "true",
    "FORGEJO__repository__ENABLE_PUSH_CREATE_ORG": "true",
  };
  public readonly secrets: AppSecrets;
  public readonly databasePassword: pulumi.Output<string>;
  public readonly postgresMasterPassword: pulumi.Output<string>;

  constructor(config = new pulumi.Config("selfhosted")) {
    const forgejoSecret = config.requireSecret("forgejo-secret");

    this.databasePassword = config.requireSecret("forgejoDbPassword");
    this.postgresMasterPassword = config.requireSecret("postgresPassword");
    this.secrets = {
      "FORGEJO__database__PASSWD": this.databasePassword,
      "AUTHENTIK_CLIENT_SECRET": forgejoSecret,
      "USER_EMAIL": config.requireSecret("user-gdario-email"),
      // Offline runners need stable, distinct secrets so their identities survive reconciliation.
      "RUNNER_SECRET": pulumi.secret(forgejoSecret.apply(secret =>
        crypto.createHash("sha256").update(secret + "runner-salt-v1").digest("hex").substring(0, 40)
      )),
      "ANDROID_RUNNER_SECRET": pulumi.secret(forgejoSecret.apply(secret =>
        crypto.createHash("sha256").update(secret + "android-runner-salt-v1").digest("hex").substring(0, 40)
      )),
    };
  }
}

export const forgejoSettings = new ForgejoSettings();
