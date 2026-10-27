import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { renovateRuntimeConfig } from "./config";

const renovateImage = "ghcr.io/renovatebot/renovate:41.0.0@sha256:f6043a9a4f281bfb37b2d3961133f1db9fc4c31fffbb88e55d380a62edb5523a";

export function configureRenovate(
  namespace: pulumi.Input<string>,
  token: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = [],
) {
  const name = "renovate";
  const secret = new k8s.core.v1.Secret(`${name}-credentials`, {
    metadata: { name: `${name}-credentials`, namespace },
    stringData: { RENOVATE_TOKEN: token },
  }, { dependsOn: dependencies });

  const runtimeConfig = new k8s.core.v1.ConfigMap(`${name}-config`, {
    metadata: { name: `${name}-config`, namespace },
    data: { "config.json": JSON.stringify(renovateRuntimeConfig, null, 2) },
  }, { dependsOn: dependencies });

  const serviceAccount = new k8s.core.v1.ServiceAccount(`${name}-sa`, {
    metadata: { name: `${name}-sa`, namespace },
    automountServiceAccountToken: false,
  }, { dependsOn: dependencies });

  const cronJob = new k8s.batch.v1.CronJob(name, {
    metadata: { name, namespace },
    spec: {
      schedule: "0 6 * * *",
      timeZone: "Europe/Madrid",
      concurrencyPolicy: "Forbid",
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        spec: {
          backoffLimit: 1,
          activeDeadlineSeconds: 1800,
          ttlSecondsAfterFinished: 86400,
          template: {
            metadata: { labels: { app: name } },
            spec: {
              serviceAccountName: serviceAccount.metadata.name,
              automountServiceAccountToken: false,
              restartPolicy: "Never",
              securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
              containers: [{
                name,
                image: renovateImage,
                env: [
                  { name: "RENOVATE_CONFIG_FILE", value: "/config/config.json" },
                  { name: "RENOVATE_TOKEN", valueFrom: { secretKeyRef: { name: secret.metadata.name, key: "RENOVATE_TOKEN" } } },
                  { name: "RENOVATE_BASE_DIR", value: "/tmp/renovate" },
                  { name: "HOME", value: "/tmp" },
                ],
                resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "500m", memory: "768Mi" } },
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
                volumeMounts: [{ name: "config", mountPath: "/config", readOnly: true }, { name: "tmp", mountPath: "/tmp" }],
              }],
              volumes: [{ name: "config", configMap: { name: runtimeConfig.metadata.name } }, { name: "tmp", emptyDir: {} }],
            },
          },
        },
      },
    },
  }, { dependsOn: [secret, runtimeConfig, serviceAccount, ...dependencies] });

  return { secret, runtimeConfig, serviceAccount, cronJob };
}
