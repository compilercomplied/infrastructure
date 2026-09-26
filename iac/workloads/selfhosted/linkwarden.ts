import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp } from "../../library/selfhosted-component";
import { Labels } from "./labels";
import { linkwardenSettings } from "./linkwarden-settings";

export function configureLinkwarden(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {

  // Configure the frontend/application using the self-hosted application component.
  // Linkwarden relies on the shared Postgres instance; the database backup is
  // handled declaratively by the component.
  const app = new SelfhostedApp("linkwarden", {
    namespace,
    image: "ghcr.io/linkwarden/linkwarden:v2.14.1",
    endpoints: [{ name: "http", servicePort: 80, containerPort: 3000, ingress: { name: "linkwarden", host: "linkwarden.gdario.dev" }, healthCheck: { protocol: "tcp" } }],
    labels: {
      [Labels.Network.AllowPostgres]: "true",
      [Labels.Network.AllowAuthentik]: "true",
    },
    settings: linkwardenSettings,
    databases: [
      {
        type: "postgres",
        databaseName: "linkwarden",
        host: "shared-postgres.shared-resources.svc.cluster.local",
        username: "linkwarden",
        passwordSecret: linkwardenSettings.secrets["POSTGRES_PASSWORD"],
      },
    ],
    volumes: [
      {
        name: "linkwarden-data",
        mountPath: "/data/data",
        size: "10Gi",
        pvcName: "linkwarden-pvc",
      },
    ],
    dependencies,
  });

  return {
    deployment: app.deployment,
  };
}
