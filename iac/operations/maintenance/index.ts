import * as k8s from "@pulumi/kubernetes";

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

  return imageGc;
}
