import * as k8s from "@pulumi/kubernetes";
import { resticEnvironment, resticImage } from "./backup";

/**
 * Cluster Maintenance Jobs
 * Prunes unused container images daily via crictl, preventing disk fill-up.
 * Uses nsenter to run k3s crictl directly in the host's namespace.
 */
export function configureMaintenance() {
  const imageGc = new k8s.batch.v1.CronJob("image-gc", {
    metadata: {
      name: "image-gc",
      namespace: "kube-system",
    },
    spec: {
      schedule: "0 3 * * *",
      concurrencyPolicy: "Forbid",
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        spec: {
          template: {
            spec: {
              hostPID: true,
              restartPolicy: "OnFailure",
              containers: [{
                name: "image-gc",
                image: "alpine:3.19",
                command: [
                  "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "--",
                  "k3s", "crictl", "rmi", "--prune",
                ],
                securityContext: {
                  privileged: true,
                },
              }],
            },
          },
        },
      },
    },
  });

  const resticMaintenance = new k8s.batch.v1.CronJob("restic-maintenance", {
    metadata: {
      name: "restic-maintenance",
      namespace: "kube-system",
    },
    spec: {
      // Backups are spread across 03:00-03:44; maintenance gets a quiet repository window.
      schedule: "0 5 * * *",
      timeZone: "Europe/Madrid",
      concurrencyPolicy: "Forbid",
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 5,
      jobTemplate: {
        spec: {
          backoffLimit: 1,
          activeDeadlineSeconds: 21600,
          template: {
            spec: {
              restartPolicy: "OnFailure",
              containers: [{
                name: "restic-maintenance",
                image: resticImage,
                args: [
                  "--retry-lock", "30m",
                  "forget",
                  "--group-by", "tags,paths",
                  "--keep-daily", "7",
                  "--keep-weekly", "4",
                  "--keep-monthly", "12",
                  "--prune",
                ],
                env: resticEnvironment(),
              }],
            },
          },
        },
      },
    },
  });

  return { imageGc, resticMaintenance };
}
