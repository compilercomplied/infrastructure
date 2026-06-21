import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import { postgresClientImage } from "../selfhosted/shared-postgres";

// Load the standalone script files to satisfy the script-ownership guidelines.
// This decouples script logic from the Pulumi infrastructure definition.
const postgresBackupScript = fs.readFileSync(path.join(__dirname, "scripts", "backup-postgres.sh"), "utf8");
const pvcBackupScript = fs.readFileSync(path.join(__dirname, "scripts", "backup-pvc.sh"), "utf8");

const config = new pulumi.Config("maintenance");
const resticRepository = config.requireSecret("resticRepository");
const resticPassword = config.requireSecret("resticPassword");
const r2AccessKeyId = config.requireSecret("r2AccessKeyId");
const r2SecretAccessKey = config.requireSecret("r2SecretAccessKey");

export type BackupSource =
  | {
      type: "postgres";
      databaseName: string;
      dbHost: string;
      dbUser: string;
      dbPasswordSecret: pulumi.Input<string>;
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
    schedule = "0 3 * * *", // Default schedule runs daily at 3 AM
    source,
    dependencies = [],
    parent,
    aliases,
  } = args;

  const cronJobName = source.type === "postgres"
    ? `${appName}-postgres-${source.databaseName}`
    : `${appName}-pvc-${source.pvcName}`;

  // Provision a job-specific ConfigMap to hold the scripts in the target namespace.
  const scriptsConfigMap = new k8s.core.v1.ConfigMap(`${cronJobName}-scripts`, {
    metadata: {
      name: `${cronJobName}-scripts`,
      namespace: namespace,
    },
    data: {
      "backup-postgres.sh": postgresBackupScript,
      "backup-pvc.sh": pvcBackupScript,
    },
  }, { dependsOn: dependencies, parent, aliases });

  let image: string;
  let scriptName: string;
  const env: k8s.types.input.core.v1.EnvVar[] = [
    { name: "RESTIC_REPOSITORY", value: resticRepository },
    { name: "RESTIC_PASSWORD", value: resticPassword },
    { name: "AWS_ACCESS_KEY_ID", value: r2AccessKeyId },
    { name: "AWS_SECRET_ACCESS_KEY", value: r2SecretAccessKey },
    // Cloudflare R2 is S3-compatible but requires a dummy region to satisfy Restic's S3 driver.
    { name: "AWS_DEFAULT_REGION", value: "us-east-1" },
  ];
  const volumes: k8s.types.input.core.v1.Volume[] = [];
  const volumeMounts: k8s.types.input.core.v1.VolumeMount[] = [];

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
    scriptName = "backup-postgres.sh";
    image = postgresClientImage;

    env.push(
      { name: "DB_HOST", value: source.dbHost },
      { name: "DB_USER", value: source.dbUser },
      { name: "DB_NAME", value: source.databaseName },
      { name: "DB_PASSWORD", value: source.dbPasswordSecret },
      { name: "APP_NAME", value: appName }
    );
  } else {
    scriptName = "backup-pvc.sh";
    // Use standard Alpine image for simple directory backups.
    image = "alpine:3.19";

    env.push(
      { name: "BACKUP_PATH", value: source.mountPath },
      { name: "APP_NAME", value: appName }
    );

    // Mount target PVC in read-only mode to prevent any chance of application
		// data corruption.
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

  const jobDeps = [scriptsConfigMap, ...dependencies];

  return new k8s.batch.v1.CronJob(cronJobName, {
    metadata: {
      name: cronJobName,
      namespace: namespace,
    },
    spec: {
      schedule: schedule,
      concurrencyPolicy: "Forbid", // Avoid concurrent backups on the same bucket to prevent lock contention
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 5,
      jobTemplate: {
        spec: {
          template: {
            spec: {
              restartPolicy: "OnFailure",
              containers: [{
                name: "restic-backup",
                image: image,
                // Execute the mounted script directly from the ConfigMap volume
                command: ["/bin/sh", `/scripts/${scriptName}`],
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
