import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createPVC } from "../library/k8s-pvc";

const bootstrapScriptContent = fs.readFileSync(path.join(__dirname, "../maintenance/scripts/bootstrap-forgejo-runner.sh"), "utf8");

export function configureForgejoRunner(
  namespace: pulumi.Input<string>,
  runnerSecret: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "forgejo-runner";
  const runnerImage = "code.forgejo.org/forgejo/runner:3.3.0";
  const dindImage = "docker:dind";

  // 1. ConfigMaps for Bootstrap script and configuration file
  const bootstrapConfigMap = new k8s.core.v1.ConfigMap(`${name}-bootstrap-scripts`, {
    metadata: {
      name: `${name}-bootstrap-scripts`,
      namespace,
    },
    data: {
      "bootstrap-forgejo-runner.sh": bootstrapScriptContent,
    },
  }, { dependsOn: dependencies });

  const runnerConfigMap = new k8s.core.v1.ConfigMap(`${name}-config`, {
    metadata: {
      name: `${name}-config`,
      namespace,
    },
    data: {
      "config.yaml": `log:
  level: info

runner:
  file: /data/.runner
  capacity: 2
  labels:
    - "ubuntu-latest:docker://node:20-bullseye"
    - "ubuntu-22.04:docker://node:20-bullseye"
    - "ubuntu-20.04:docker://node:20-bullseye"

container:
  docker_host: tcp://localhost:2375
`,
    },
  }, { dependsOn: dependencies });

  // 2. Secret containing the pre-shared registration secret
  const secrets = new k8s.core.v1.Secret(`${name}-secrets`, {
    metadata: {
      name: `${name}-secrets`,
      namespace,
    },
    stringData: {
      "RUNNER_SECRET": runnerSecret,
    },
  }, { dependsOn: dependencies });

  // 3. Persistent Volume Claim for the runner state
  // Storing the runner state (.runner credentials) in a PVC guarantees that the runner
  // maintains its registered UUID/identity across pod restarts and deployments.
  const pvc = createPVC({
    name: `${name}-pvc`,
    namespace,
    size: "2Gi",
    dependencies,
  });

  // 4. Deployment containing both the runner daemon and the docker:dind sidecar
  const deployment = new k8s.apps.v1.Deployment(name, {
    metadata: {
      name,
      namespace,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: { app: name },
      },
      template: {
        metadata: {
          labels: { app: name },
        },
        spec: {
          containers: [
            {
              name: "runner",
              image: runnerImage,
              command: ["/bin/bash", "/scripts/bootstrap-forgejo-runner.sh"],
              env: [
                {
                  name: "RUNNER_SECRET",
                  valueFrom: {
                    secretKeyRef: {
                      name: secrets.metadata.name,
                      key: "RUNNER_SECRET",
                    },
                  },
                },
                {
                  name: "DOCKER_HOST",
                  value: "tcp://localhost:2375",
                },
              ],
              volumeMounts: [
                {
                  name: "data",
                  mountPath: "/data",
                },
                {
                  name: "config",
                  mountPath: "/config",
                },
                {
                  name: "bootstrap-scripts",
                  mountPath: "/scripts",
                },
              ],
            },
            {
              name: "dind",
              image: dindImage,
              securityContext: {
                privileged: true,
              },
              env: [
                {
                  name: "DOCKER_TLS_CERTDIR",
                  value: "",
                },
              ],
              volumeMounts: [
                {
                  name: "docker-storage",
                  mountPath: "/var/lib/docker",
                },
              ],
            },
          ],
          volumes: [
            {
              name: "data",
              persistentVolumeClaim: {
                claimName: pvc.metadata.name,
              },
            },
            {
              name: "config",
              configMap: {
                name: runnerConfigMap.metadata.name,
              },
            },
            {
              name: "bootstrap-scripts",
              configMap: {
                name: bootstrapConfigMap.metadata.name,
                defaultMode: 0o755,
              },
            },
            {
              name: "docker-storage",
              emptyDir: {},
            },
          ],
        },
      },
    },
  }, { dependsOn: [bootstrapConfigMap, runnerConfigMap, secrets, pvc, ...dependencies] });

  return {
    deployment,
    pvc,
    secrets,
    bootstrapConfigMap,
    runnerConfigMap,
  };
}
