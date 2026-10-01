import { memosIdentity } from "./identity";
import * as pulumi from "@pulumi/pulumi";
import { AppConfig, AppSecrets, AppSettings } from "../../../library/app-settings";

export class MemosSettings implements AppSettings {
  public readonly config: AppConfig = {
    // The pinned image sets MEMOS_PORT to 5230. Restating it here keeps the
    // container port contract explicit for the Service, ingress, and probes.
    "MEMOS_PORT": "5230",
    "MEMOS_DRIVER": "postgres",
    // Data directory for the SQLite fallback and for locally stored attachments
    // (the default storage template writes to ./assets).
    "MEMOS_DATA": "/var/opt/memos",
    // Memos builds OAuth redirect and cookie URLs from this canonical address,
    // which is also the address registered as the callback in Authentik.
    "MEMOS_INSTANCE_URL": memosIdentity.url,
  };
  public readonly secrets: AppSecrets;
  public readonly databasePassword: pulumi.Output<string>;

  constructor(config = new pulumi.Config("selfhosted")) {
    this.databasePassword = config.requireSecret("memosDbPassword");
    this.secrets = {
      "MEMOS_DSN": pulumi.interpolate`postgres://memos:${this.databasePassword}@shared-postgres.shared-resources.svc.cluster.local:5432/memos?sslmode=disable`,
    };
  }
}

export const memosSettings = new MemosSettings();
