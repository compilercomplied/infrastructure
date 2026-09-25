import * as pulumi from "@pulumi/pulumi";

export type AppConfig = Record<string, string>;

export type AppSecrets = Record<string, pulumi.Input<string>>;

export interface AppSettings {
  config: AppConfig;
  secrets: AppSecrets;
}
