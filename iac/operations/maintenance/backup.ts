import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import { postgresClientImage } from "../../platform/shared-resources/shared-postgres";
import { Labels } from "../../workloads/selfhosted/labels";

// Load the standalone script files to satisfy the script-ownership guidelines.
// This decouples script logic from the Pulumi infrastructure definition.
const postgresBackupScript = fs.readFileSync(path.join(__dirname, "scripts", "backup-postgres.sh"), "utf8");
const mariadbBackupScript = fs.readFileSync(path.join(__dirname, "scripts", "backup-mariadb.sh"), "utf8");
const pvcBackupScript = fs.readFileSync(path.join(__dirname, "scripts", "backup-pvc.sh"), "utf8");
const resticBackupScript = fs.readFileSync(path.join(__dirname, "scripts", "backup-restic.sh"), "utf8");

// A digest keeps backup behavior stable even if the upstream tag is later replaced.
export const resticImage = "restic/restic@sha256:9940e6c7421ab3a21ee9fdc4e91596d04c792b600d31b102696c75cbf3ac4481";

const config = new pulumi.Config("maintenance");
const resticRepository = config.requireSecret("resticRepository");
const resticPassword = config.requireSecret("resticPassword");
const r2AccessKeyId = config.requireSecret("r2AccessKeyId");
const r2SecretAccessKey = config.requireSecret("r2SecretAccessKey");

export function resticEnvironment(): k8s.types.input.core.v1.EnvVar[] {
  return [
    { name: "RESTIC_REPOSITORY", value: resticRepository },
    { name: "RESTIC_PASSWORD", value: resticPassword },
    { name: "AWS_ACCESS_KEY_ID", value: r2AccessKeyId },
    { name: "AWS_SECRET_ACCESS_KEY", value: r2SecretAccessKey },
    // Cloudflare R2 is S3-compatible but requires a region for the S3 client.
    { name: "AWS_DEFAULT_REGION", value: "us-east-1" },
    { name: "RESTIC_CACHE_DIR", value: "/tmp/restic-cache" },
  ];
}

function stableScheduleMinute(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  }
  return hash % 45;
}

export type BackupSource =
  | {
      type: "postgres";
      databaseName: string;
      dbHost: pulumi.Input<string>;
      dbUser: string;
      dbPasswordSecret: pulumi.Input<string>;
    }
  | {
      type: "mariadb";
      databaseName: string;
      dbHost: pulumi.Input<string>;
      dbUser: string;
      dbPasswordSecret: pulumi.Input<string>;
      clientImage: string;
    }
  | {
      type: "pvc";
      pvcName: string;
      mountPath: string; // Path inside the container where the PVC will be mounted to read files
    };

export interface BackupJobArgs {
  appName: string;
  namespace: pulumi.Input<string>;
  schedule?: string;
  source: BackupSource;
  dependencies?: pulumi.Resource[];
  /** Optional parent resource to establish the Pulumi resource hierarchy. */
  parent?: pulumi.Resource;
  /** Optional aliases to preserve resource URNs when migrating resources under component resources. */
  aliases?: pulumi.Alias[];
}

// Configures a standardized Kubernetes CronJob running Restic to back up a database or PVC to Cloudflare R2.
// Note on namespace constraint: The backup job must reside in the target application's namespace.
// This is because Kubernetes PersistentVolumeClaims (PVCs) are namespace-scoped, and a Pod in one namespace
// cannot mount a PVC that belongs to another namespace. Moving the CronJob and its helper ConfigMap
// to the application's namespace satisfies this Kubernetes security and isolation model.
export function createBackupJob(args: BackupJobArgs): k8s.batch.v1.CronJob {
  const {
    appName,
    namespace,
    schedule,
    source,
    dependencies = [],
    parent,
    aliases,
  } = args;

  const cronJobName = source.type === "postgres"
    ? `${appName}-postgres-${source.databaseName}`
    : source.type === "mariadb"
    ? `${appName}-mariadb-${source.databaseName}`
    : `${appName}-pvc-${source.pvcName}`;

  // Provision a job-specific ConfigMap to hold the scripts in the target namespace.
  const scriptsConfigMap = new k8s.core.v1.ConfigMap(`${cronJobName}-scripts`, {
    metadata: {
      name: `${cronJobName}-scripts`,
      namespace: namespace,
    },
    data: {
      "backup-postgres.sh": postgresBackupScript,
      "backup-mariadb.sh": mariadbBackupScript,
      "backup-pvc.sh": pvcBackupScript,
      "backup-restic.sh": resticBackupScript,
    },
  }, { dependsOn: dependencies, parent, aliases });

  let dumpContainer: k8s.types.input.core.v1.Container | undefined;
  const env = resticEnvironment();
  const volumes: k8s.types.input.core.v1.Volume[] = [];
  const volumeMounts: k8s.types.input.core.v1.VolumeMount[] = [];
  const backupId = cronJobName;

  // Always mount the ConfigMap containing our parameterized scripts.
  volumes.push({
    name: "backup-scripts-volume",
    configMap: {
      name: scriptsConfigMap.metadata.name,
      defaultMode: 0o755, // Set execute bit so scripts can be run directly
    },
  });

  volumeMounts.push({
    name: "backup-scripts-volume",
    mountPath: "/scripts",
    readOnly: true,
  });

  if (source.type === "postgres") {
    const dumpEnv: k8s.types.input.core.v1.EnvVar[] = [
      { name: "DB_HOST", value: source.dbHost },
      { name: "DB_USER", value: source.dbUser },
      { name: "DB_NAME", value: source.databaseName },
      { name: "DB_PASSWORD", value: source.dbPasswordSecret },
      { name: "BACKUP_PATH", value: "/backup" },
    ];
    dumpContainer = {
      name: "database-dump",
      image: postgresClientImage,
      command: ["/bin/sh", "/scripts/backup-postgres.sh"],
      env: dumpEnv,
      volumeMounts: [volumeMounts[0], { name: "backup-source-volume", mountPath: "/backup" }],
    };
  } else if (source.type === "mariadb") {
    const dumpEnv: k8s.types.input.core.v1.EnvVar[] = [
      { name: "DB_HOST", value: source.dbHost },
      { name: "DB_USER", value: source.dbUser },
      { name: "DB_NAME", value: source.databaseName },
      { name: "DB_PASSWORD", value: source.dbPasswordSecret },
      { name: "BACKUP_PATH", value: "/backup" },
    ];
    dumpContainer = {
      name: "database-dump",
      image: source.clientImage,
      command: ["/bin/sh", "/scripts/backup-mariadb.sh"],
      env: dumpEnv,
      volumeMounts: [volumeMounts[0], { name: "backup-source-volume", mountPath: "/backup" }],
    };
  } else {
    volumes.push({
      name: "backup-source-volume",
      persistentVolumeClaim: {
        claimName: source.pvcName,
        readOnly: true,
      },
    });

    volumeMounts.push({
      name: "backup-source-volume",
      mountPath: source.mountPath,
      readOnly: true,
    });
  }

  if (source.type !== "pvc") {
    // Database dumps are materialized before Restic starts so a failed dump can never
    // produce a successful-looking repository snapshot.
    volumes.push({ name: "backup-source-volume", emptyDir: {} });
    volumeMounts.push({ name: "backup-source-volume", mountPath: "/backup", readOnly: true });
  }

  env.push(
    { name: "BACKUP_PATH", value: source.type === "pvc" ? source.mountPath : "/backup" },
    { name: "BACKUP_FILE", value: source.type === "pvc" ? "" : `${source.databaseName}.sql` },
    { name: "BACKUP_KIND", value: source.type === "pvc" ? "pvc" : "database" },
    { name: "BACKUP_ENGINE", value: source.type === "pvc" ? "" : source.type },
    { name: "BACKUP_ID", value: backupId },
    { name: "APP_NAME", value: appName },
  );

  const jobDeps = [scriptsConfigMap, ...dependencies];

  const cronJobLabels: Record<string, string> = {};
  if (source.type === "postgres") {
    cronJobLabels[Labels.Network.AllowPostgres] = "true";
  } else if (source.type === "mariadb") {
    cronJobLabels[Labels.Network.AllowMariaDb] = "true";
  }

  return new k8s.batch.v1.CronJob(cronJobName, {
    metadata: {
      name: cronJobName,
      namespace: namespace,
    },
    spec: {
      // Spreading repository writes reduces R2 pressure without relying on mutable per-app configuration.
      schedule: schedule ?? `${stableScheduleMinute(cronJobName)} 3 * * *`,
      timeZone: "Europe/Madrid",
      concurrencyPolicy: "Forbid",
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 5,
      jobTemplate: {
        spec: {
          backoffLimit: 1,
          activeDeadlineSeconds: 7200,
          template: {
            metadata: {
              labels: cronJobLabels,
            },
            spec: {
              restartPolicy: "OnFailure",
              initContainers: dumpContainer ? [dumpContainer] : undefined,
              containers: [{
                name: "restic-backup",
                image: resticImage,
                command: ["/bin/sh", "/scripts/backup-restic.sh"],
                env: env,
                volumeMounts: volumeMounts,
              }],
              volumes: volumes,
            },
          },
        },
      },
    },
  }, { dependsOn: jobDeps, parent, aliases });
}
