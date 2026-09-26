import * as pulumi from "@pulumi/pulumi";
import { AppConfig, AppSecrets, AppSettings } from "../../library/app-settings";

export class GrimmorySettings implements AppSettings {
  public readonly config: AppConfig;
  public readonly secrets: AppSecrets;

  constructor(config = new pulumi.Config("selfhosted")) {
    this.config = {
      "DATABASE_URL": "jdbc:mariadb://shared-mariadb.shared-resources.svc.cluster.local:3306/grimmory",
      "DATABASE_USERNAME": "grimmory",
      "USER_ID": "1000",
      "GROUP_ID": "1000",
      "TZ": "Europe/Rome",
      "DISK_TYPE": "LOCAL",
    };

    this.secrets = {
      "DATABASE_PASSWORD": config.requireSecret("grimmoryDbPassword"),
      "OIDC_CLIENT_SECRET": config.requireSecret("grimmory-secret"),
    };
  }
}
