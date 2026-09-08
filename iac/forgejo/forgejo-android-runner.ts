import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createPVC } from "../library/k8s-pvc";

// Byte-for-byte copy of the generic runner bootstrap, using the same FORGEJO_INTERNAL_URL
// and DOCKER_HOST replacement-token logic so the android runner registers over a pre-shared
// RUNNER_SECRET and persists .runner in a PVC exactly like its sibling. Only the runner image
// source differs (we mount /dev/kvm for the dind sidecar, never referencing a node by name).
const bootstrapScriptContent = fs.readFileSync(
  path.join(__dirname, "../maintenance/scripts/bootstrap-forgejo-android-runner.sh"),
  "utf8"
);

// The android/civite/emulator jobs are scheduled by a nodeSelector (not a hard-coded node name),
// so the cluster operator can taint/label whichever physical host actually exposes /dev/kvm
// without touching this IaC.
const androidRunnerNodeLabel = "ci.gdario.dev/android-kvm";

export function configureForgejoAndroidRunner(
  namespace: pulumi.Input<string>,
  runnerSecret: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "forgejo-android-runner";

  // Same shared forgejo namespace as the app: the runner needs to reach the Forgejo cluster
  // service and to co-locate, so it deliberately does NOT create a namespace of its own.
  const config = new pulumi.Config("selfhosted");
  const runnerImage =
    config.get("androidRunnerImage") ?? "code.forgejo.org/forgejo/runner:3.3.0";
  const dindImage = config.get("androidDindImage") ?? "docker:dind";

  // Bootstrap and runner-config ConfigMaps. The runner config leaves container.options empty:
  // forward the host /dev/kvm from DinD into the *job* container requires config that we cannot
  // claim works end-to-end. KVM device forwarding from the privileged dind into the subsequent
  // unprivileged job container must be validated live and is tracked in the android-kvm runner
  // issue; until then this is the hook where the --device flag would be added.
  const bootstrapConfigMap = new k8s.core.v1.ConfigMap(`${name}-bootstrap-scripts`, {
    metadata: { name: `${name}-bootstrap-scripts`, namespace },
    data: {
      "bootstrap-forgejo-android-runner.sh": bootstrapScriptContent,
    },
  }, { dependsOn: dependencies });

  const runnerConfigMap = new k8s.core.v1.ConfigMap(`${name}-config`, {
    metadata: { name: `${name}-config`, namespace },
    data: {
      "config.yaml": `log:
  level: info

runner:
  file: /data/.runner
  capacity: 1
  envs:
    DOCKER_HOST: DOCKER_HOST_REPLACE_ME
  labels:
    - "android-kvm:docker://catthehacker/ubuntu:act-latest"

container:
  docker_host: DOCKER_HOST_REPLACE_ME
  options: ""
`,
    },
  }, { dependsOn: dependencies });

  const secrets = new k8s.core.v1.Secret(`${name}-secrets`, {
    metadata: { name: `${name}-secrets`, namespace },
    stringData: { RUNNER_SECRET: runnerSecret },
  }, { dependsOn: dependencies });

  // Job containers for this runner run as unprivileged normal-OCI containers (no privileged jobs),
  // so they only need a small PVC for the .runner identity, mirroring the generic runner.
  const pvc = createPVC({
    name: `${name}-pvc`,
    namespace,
    size: "2Gi",
    dependencies,
  });

  // Dedicated, locked-down identity: the pod only needs the default API token nowhere, so the
  // service account and the pod both opt out of the projected token (automountServiceAccountToken:
  // false) to shrink the attack surface of a host-facing agent.
  const serviceAccount = new k8s.core.v1.ServiceAccount(`${name}-sa`, {
    metadata: { name: `${name}-sa`, namespace },
    automountServiceAccountToken: false,
  }, { dependsOn: dependencies });

  const deployment = new k8s.apps.v1.Deployment(name, {
    metadata: { name, namespace },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          serviceAccountName: serviceAccount.metadata.name,
          automountServiceAccountToken: false,
          // Lock down host exposure: no hostNetwork/hostPID/hostIPC and no docker.sock hostPath.
          // dind gets its own emptyDir dockersock, and /dev/kvm comes in as an explicit CharDevice
          // mounted only into the privileged dind sidecar.
          nodeSelector: { [androidRunnerNodeLabel]: "true" },
          tolerations: [
            {
              key: androidRunnerNodeLabel,
              operator: "Equal",
              value: "true",
              effect: "NoSchedule",
            },
          ],
          // runtimeClassName intentionally omitted so pods run on the default (runc) runtime, not kata.
          containers: [
            {
              name: "runner",
              image: runnerImage,
              command: ["/bin/bash", "/scripts/bootstrap-forgejo-android-runner.sh"],
              env: [
                {
                  name: "RUNNER_SECRET",
                  valueFrom: {
                    secretKeyRef: { name: secrets.metadata.name, key: "RUNNER_SECRET" },
                  },
                },
                { name: "DOCKER_HOST", value: "unix:///var/run/docker.sock" },
                { name: "FORGEJO_INTERNAL_URL", value: "http://forgejo.forgejo.svc.cluster.local:80/" },
                { name: "FORGEJO_PUBLIC_URL", value: "https://git.gdario.dev" },
              ],
              volumeMounts: [
                { name: "data", mountPath: "/data" },
                { name: "config", mountPath: "/config" },
                { name: "bootstrap-scripts", mountPath: "/scripts" },
                { name: "dind-socket", mountPath: "/var/run" },
              ],
            },
            {
              // dind is the only privileged container here; /dev/kvm cannot be reached from inside
              // an unprivileged runner otherwise, so it is the single exception to the no-privilege rule.
              name: "dind",
              image: dindImage,
              args: ["dockerd", "--host=unix:///var/run/docker.sock"],
              securityContext: { privileged: true },
              env: [{ name: "DOCKER_TLS_CERTDIR", value: "" }],
              volumeMounts: [
                { name: "docker-storage", mountPath: "/var/lib/docker" },
                { name: "dind-socket", mountPath: "/var/run" },
                { name: "dev-kvm", mountPath: "/dev/kvm" },
              ],
            },
          ],
          volumes: [
            { name: "data", persistentVolumeClaim: { claimName: pvc.metadata.name } },
            { name: "config", configMap: { name: runnerConfigMap.metadata.name } },
            {
              name: "bootstrap-scripts",
              configMap: { name: bootstrapConfigMap.metadata.name, defaultMode: 0o755 },
            },
            { name: "docker-storage", emptyDir: {} },
            { name: "dind-socket", emptyDir: {} },
            // Pass the host's KVM accelerator into the dind pods. Forwarding it onward into the
            // unprivileged job container is a separate open question (see container options above).
            {
              name: "dev-kvm",
              hostPath: { path: "/dev/kvm", type: "CharDevice" },
            },
          ],
        },
      },
    },
  }, { dependsOn: [bootstrapConfigMap, runnerConfigMap, secrets, pvc, serviceAccount, ...dependencies] });

  // The android runner downloads SDK/system images and build artifacts, so unlike most self-hosted
  // apps it needs controlled EGRESS. policyTypes is Egress-only: ingress stays governed by the shared
  // namespace default-deny that the namespace security applies. The podSelector matches the job pod
  // by its app label, which is the same select value the deployment nodeSelector targets.
  //
  // Allowed egress, and why:
  //  * 53/udp+53/tcp to kube-dns (kube-system) — pod and job DNS resolution.
  //  * 80 to the in-cluster Forgejo service — job repo clone/push over http.
  //  * 443 to the world — OCI registry, and google/maven artifact hosts that serve jobs. Exact
  //    egress CIDRs are environment-dependent (mirrors, enterprise proxies) so they are expressed
  //    as a scoped 443-only allowance to 0.0.0.0/0; this does NOT open node-management or the k8s
  //    apiserver, which listen on non-443 and would need their own explicit rule.
  const networkPolicy = new k8s.networking.v1.NetworkPolicy(`${name}-egress`, {
    metadata: { name: `${name}-egress`, namespace },
    spec: {
      podSelector: { matchLabels: { app: name } },
      policyTypes: ["Egress"],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
              },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: [
            { port: 53, protocol: "UDP" },
            { port: 53, protocol: "TCP" },
          ],
        },
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "forgejo" },
              },
              podSelector: { matchLabels: { app: "forgejo" } },
            },
          ],
          ports: [{ port: 80, protocol: "TCP" }],
        },
        {
          to: [{ ipBlock: { cidr: "0.0.0.0/0" } }],
          ports: [{ port: 443, protocol: "TCP" }],
        },
      ],
    },
  }, { dependsOn: [deployment] });

  return {
    deployment,
    serviceAccount,
    networkPolicy,
    bootstrapConfigMap,
    runnerConfigMap,
  };
}
