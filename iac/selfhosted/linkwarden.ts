import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp } from "../library/selfhosted-component";
import { Labels } from "./labels";

export function configureLinkwarden(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config("selfhosted");
  const linkwardenDbPassword = config.requireSecret("linkwardenDbPassword");
  const linkwardenSecret = config.requireSecret("linkwarden-secret");
  const linkwardenNextAuthSecret = config.requireSecret("linkwardenNextAuthSecret");

  // Configure the frontend/application using the self-hosted application component.
  // Linkwarden relies on the shared Postgres instance; the database backup is
  // handled declaratively by the component.
  const app = new SelfhostedApp("linkwarden", {
    namespace,
    image: "ghcr.io/linkwarden/linkwarden:v2.14.1",
    containerPort: 3000,
    exposeType: "public",
    host: "linkwarden.gdario.dev",
    labels: {
      [Labels.Network.AllowPostgres]: "true",
      [Labels.Network.AllowAuthentik]: "true",
    },
    secrets: {
      "NEXTAUTH_SECRET": linkwardenNextAuthSecret,
      "POSTGRES_PASSWORD": linkwardenDbPassword,
      "AUTHENTIK_CLIENT_SECRET": linkwardenSecret,
      "NEXT_PUBLIC_DISABLE_REGISTRATION": "true",
      "NEXT_PUBLIC_CREDENTIALS_ENABLED": "false",
      "DATABASE_URL": pulumi.interpolate`postgresql://linkwarden:${linkwardenDbPassword}@shared-postgres.shared-resources.svc.cluster.local:5432/linkwarden`,
    },
    env: [
      {
        name: "NEXTAUTH_URL",
        value: "https://linkwarden.gdario.dev/api/v1/auth",
      },
      { name: "NEXT_PUBLIC_AUTHENTIK_ENABLED", value: "true" },
      { name: "AUTHENTIK_CUSTOM_NAME", value: "authentik" },
      {
        name: "AUTHENTIK_ISSUER",
        value: "https://auth.gdario.dev/application/o/linkwarden",
      },
      { name: "AUTHENTIK_CLIENT_ID", value: "linkwarden-client-id" },
    ],
    databases: [
      {
        type: "postgres",
        databaseName: "linkwarden",
        host: "shared-postgres.shared-resources.svc.cluster.local",
        username: "linkwarden",
        passwordSecret: linkwardenDbPassword,
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
