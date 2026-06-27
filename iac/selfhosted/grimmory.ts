import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { createSelfhostedApp } from "../library/selfhosted-app";
import { createPVC } from "../library/k8s-pvc";
import { createBackupJob } from "../maintenance/backup";
import { Labels } from "./labels";

export const grimmoryImage = "ghcr.io/grimmory-tools/grimmory:v3.2.0";
export const grimmoryMariaDbImage = "mariadb:11.4";

export function configureGrimmory(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config("selfhosted");
  const grimmoryDbPassword = config.requireSecret("grimmoryDbPassword");
  const grimmorySecret = config.requireSecret("grimmory-secret");

  const dbName = "grimmory-db";

  // BY DESIGN: MariaDB is deployed as a dedicated database instance baked directly into Grimmory.
  // Since Grimmory is currently the only workload in the stack requiring MariaDB/MySQL (the others use PostgreSQL),
  // keeping it dedicated simplifies isolation. However, if any other application in the future requires MariaDB,
  // this module should be refactored to extract the MariaDB StatefulSet, Service, and secrets into a shared-mariadb
  // component (similar to shared-postgres.ts) to avoid resource duplication.
  const dbPvc = createPVC({
    name: `${dbName}-pvc`,
    namespace,
    size: "2Gi",
    dependencies,
  });

  const dbSecret = new k8s.core.v1.Secret(`${dbName}-secrets`, {
    metadata: {
      name: `${dbName}-secrets`,
      namespace,
    },
    stringData: {
      "MYSQL_ROOT_PASSWORD": grimmoryDbPassword,
      "MYSQL_PASSWORD": grimmoryDbPassword,
      "MYSQL_USER": "grimmory",
      "MYSQL_DATABASE": "grimmory",
    },
  }, { dependsOn: dependencies });

  // StatefulSet ensures a stable identity and volume lock for the database pod.
  const dbStatefulSet = new k8s.apps.v1.StatefulSet(dbName, {
    metadata: {
      name: dbName,
      namespace,
    },
    spec: {
      serviceName: dbName,
      replicas: 1,
      selector: {
        matchLabels: { app: dbName },
      },
      template: {
        metadata: {
          labels: { app: dbName },
        },
        spec: {
          containers: [{
            name: "mariadb",
            image: grimmoryMariaDbImage,
            ports: [{ containerPort: 3306, name: "mysql" }],
            // Disable Performance Schema and restrict buffers/connections to minimize RAM footprint.
            args: [
              "--performance-schema=OFF",
              "--innodb-buffer-pool-size=32M",
              "--innodb-log-buffer-size=1M",
              "--query-cache-size=0",
              "--max-connections=10",
            ],
            env: [
              {
                name: "MYSQL_ROOT_PASSWORD",
                valueFrom: {
                  secretKeyRef: {
                    name: dbSecret.metadata.name,
                    key: "MYSQL_ROOT_PASSWORD",
                  },
                },
              },
              {
                name: "MYSQL_DATABASE",
                value: "grimmory",
              },
              {
                name: "MYSQL_USER",
                value: "grimmory",
              },
              {
                name: "MYSQL_PASSWORD",
                valueFrom: {
                  secretKeyRef: {
                    name: dbSecret.metadata.name,
                    key: "MYSQL_PASSWORD",
                  },
                },
              },
            ],
            volumeMounts: [{
              name: "mysql-data",
              mountPath: "/var/lib/mysql",
            }],
          }],
          volumes: [{
            name: "mysql-data",
            persistentVolumeClaim: {
              claimName: dbPvc.metadata.name,
            },
          }],
        },
      },
    },
  }, { dependsOn: [dbPvc, dbSecret] });

  const dbService = new k8s.core.v1.Service(dbName, {
    metadata: {
      name: dbName,
      namespace,
    },
    spec: {
      ports: [{ port: 3306, targetPort: 3306, protocol: "TCP" }],
      selector: { app: dbName },
    },
  }, { dependsOn: dbStatefulSet });

  // Configure the frontend/application using the self-hosted application helper.
  // Standard volumes for book storage, watched folder (bookdrop), and application metadata.
  const app = createSelfhostedApp({
    name: "grimmory",
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
        value: pulumi.interpolate`jdbc:mariadb://${dbService.metadata.name}.${namespace}.svc.cluster.local:3306/grimmory`,
      },
      { name: "DATABASE_USERNAME", value: "grimmory" },
      { name: "USER_ID", value: "1000" },
      { name: "GROUP_ID", value: "1000" },
      { name: "TZ", value: "Europe/Rome" },
      { name: "DISK_TYPE", value: "LOCAL" },
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
      },
    ],
    dependencies: [...dependencies, dbService],
  });

  const dbBackup = createBackupJob({
    appName: "grimmory",
    namespace,
    source: {
      type: "mariadb",
      databaseName: "grimmory",
      dbHost: pulumi.interpolate`${dbService.metadata.name}.${namespace}.svc.cluster.local`,
      dbUser: "grimmory",
      dbPasswordSecret: grimmoryDbPassword,
      clientImage: grimmoryMariaDbImage,
    },
    dependencies: [...dependencies, dbService, app.deployment],
  });

  const booksBackup = createBackupJob({
    appName: "grimmory",
    namespace,
    source: {
      type: "pvc",
      pvcName: "grimmory-books-pvc",
      mountPath: "/books",
    },
    dependencies: [...dependencies, app.deployment],
  });

  const dataBackup = createBackupJob({
    appName: "grimmory",
    namespace,
    source: {
      type: "pvc",
      pvcName: "grimmory-data-pvc",
      mountPath: "/app/data",
    },
    dependencies: [...dependencies, app.deployment],
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
              { name: "DB_HOST", value: pulumi.interpolate`${dbService.metadata.name}.${namespace}.svc.cluster.local` },
              { name: "DB_USER", value: "grimmory" },
              {
                name: "DB_PASSWORD",
                valueFrom: {
                  secretKeyRef: {
                    name: dbSecret.metadata.name,
                    key: "MYSQL_PASSWORD",
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
    dependsOn: [dbService, app.deployment, patchScriptConfigMap],
    replaceOnChanges: ["metadata.annotations"],
    deleteBeforeReplace: true,
  });

  // NetworkPolicy to allow MariaDB ingress only from pods with AllowMariaDb capability label
  const mariadbPolicy = new k8s.networking.v1.NetworkPolicy("allow-mariadb-ingress", {
    metadata: {
      name: "allow-mariadb-ingress",
      namespace,
    },
    spec: {
      podSelector: {
        matchLabels: {
          app: dbName,
        },
      },
      ingress: [
        {
          from: [
            {
              podSelector: {
                matchLabels: {
                  [Labels.Network.AllowMariaDb]: "true",
                },
              },
            },
          ],
          ports: [{ port: 3306 }],
        },
      ],
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: dbService });

  return {
    ...app,
    dbService,
    dbBackup,
    booksBackup,
    dataBackup,
    patchJob,
    mariadbPolicy,
  };
}
