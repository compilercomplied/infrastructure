import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { SelfhostedApp } from "../library/selfhosted-component";
import { Labels } from "./labels";

export const grimmoryImage = "ghcr.io/grimmory-tools/grimmory:v3.2.0";
export const grimmoryMariaDbImage = "mariadb:11.4";

export function configureGrimmory(
  namespace: pulumi.Input<string>,
  mariadbService: k8s.core.v1.Service,
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config("selfhosted");
  const grimmoryDbPassword = config.requireSecret("grimmoryDbPassword");
  const grimmorySecret = config.requireSecret("grimmory-secret");

  // Configure the frontend/application using the self-hosted application component.
  // Standard volumes for book storage, watched folder (bookdrop), and application metadata.
  const app = new SelfhostedApp("grimmory", {
    namespace,
    image: grimmoryImage,
    containerPort: 6060,
    exposeType: "public",
    host: "grimmory.gdario.dev",
    labels: {
      [Labels.Network.AllowMariaDb]: "true",
      [Labels.Network.AllowAuthentik]: "true",
    },
    secrets: {
      "DATABASE_PASSWORD": grimmoryDbPassword,
      "OIDC_CLIENT_SECRET": grimmorySecret,
    },
    env: [
      {
        name: "DATABASE_URL",
        value: pulumi.interpolate`jdbc:mariadb://${mariadbService.metadata.name}.${mariadbService.metadata.namespace}.svc.cluster.local:3306/grimmory`,
      },
      { name: "DATABASE_USERNAME", value: "grimmory" },
      { name: "USER_ID", value: "1000" },
      { name: "GROUP_ID", value: "1000" },
      { name: "TZ", value: "Europe/Rome" },
      { name: "DISK_TYPE", value: "LOCAL" },
    ],
    databases: [
      {
        type: "mariadb",
        databaseName: "grimmory",
        host: pulumi.interpolate`${mariadbService.metadata.name}.${mariadbService.metadata.namespace}.svc.cluster.local`,
        username: "grimmory",
        passwordSecret: grimmoryDbPassword,
        clientImage: grimmoryMariaDbImage,
      }
    ],
    volumes: [
      {
        name: "grimmory-data",
        mountPath: "/app/data",
        size: "2Gi",
        pvcName: "grimmory-data-pvc",
      },
      {
        name: "grimmory-books",
        mountPath: "/books",
        size: "2Gi",
        pvcName: "grimmory-books-pvc",
      },
      {
        name: "grimmory-bookdrop",
        mountPath: "/bookdrop",
        size: "1Gi",
        pvcName: "grimmory-bookdrop-pvc",
        enableBackup: false,
      },
    ],
    dependencies: [...dependencies, mariadbService],
  });

  const patchScriptContent = fs.readFileSync(
    path.join(__dirname, "../maintenance/scripts/patch-grimmory-db.sh"),
    "utf-8"
  );
  const patchScriptConfigMap = new k8s.core.v1.ConfigMap("patch-grimmory-db-script", {
    metadata: {
      namespace: namespace,
    },
    data: {
      "patch.sh": patchScriptContent,
    },
  }, { dependsOn: dependencies });

  const patchHash = pulumi.all([grimmorySecret, patchScriptContent]).apply(([secret, script]) => {
    return crypto.createHash("sha256").update(secret + script).digest("hex");
  });

  const patchJob = new k8s.batch.v1.Job("patch-grimmory-db", {
    metadata: {
      namespace,
      annotations: {
        "patch-hash": patchHash,
      },
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            "patch-hash": patchHash,
          },
          labels: {
            [Labels.Network.AllowMariaDb]: "true",
          },
        },
        spec: {
          restartPolicy: "Never",
          containers: [{
            name: "patch",
            image: grimmoryMariaDbImage,
            command: ["/bin/sh", "/scripts/patch.sh"],
            env: [
              { name: "DB_HOST", value: pulumi.interpolate`${mariadbService.metadata.name}.${mariadbService.metadata.namespace}.svc.cluster.local` },
              { name: "DB_USER", value: "grimmory" },
              {
                name: "DB_PASSWORD",
                valueFrom: {
                  secretKeyRef: {
                    name: app.secret!.metadata.name,
                    key: "DATABASE_PASSWORD",
                  },
                },
              },
              {
                name: "OIDC_CLIENT_SECRET",
                valueFrom: {
                  secretKeyRef: {
                    name: app.secret!.metadata.name,
                    key: "OIDC_CLIENT_SECRET",
                  },
                },
              },
            ],
            volumeMounts: [{
              name: "scripts",
              mountPath: "/scripts",
            }],
          }],
          volumes: [{
            name: "scripts",
            configMap: {
              name: patchScriptConfigMap.metadata.name,
            },
          }],
        },
      },
    },
  }, {
    dependsOn: [mariadbService, app.deployment, patchScriptConfigMap],
    replaceOnChanges: ["metadata.annotations"],
    deleteBeforeReplace: true,
  });

  return {
    deployment: app.deployment,
    mariadbService,
    patchJob,
  };
}

