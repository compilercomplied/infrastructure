import { hermesIdentity } from "./hermes-agent-identity";
import * as pulumi from "@pulumi/pulumi";
import { HermesAgent } from "../../library/hermes-agent";
import { Labels } from "../selfhosted/labels";
import { getAuthorizedUsers } from "../selfhosted/users";
import { HermesAgentSettings } from "./hermes-agent-settings";

const androidImage = "git.gdario.dev/hermes/hermes-android@sha256:30298bc5b07f19459d36783a1ecbce8acf0733fab315ba8f2c0bc898b0179b97";

export function configureHermesAgent(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = [],
) {
  const users = getAuthorizedUsers();
  const settings = new HermesAgentSettings(users.map(user => user.telegramId));

  // Pulumi previews authorize server-side dry runs using the same Kubernetes verbs as an
  // update, so Hermes needs cluster-wide access even though it does not apply changes.
  return new HermesAgent("hermes-agent", {
    namespace,
    dependencies,
    serviceAccount: {
      name: "hermes-agent-sa",
      clusterRoleName: "cluster-admin",
    },
    app: {
      image: androidImage,
      imagePullPolicy: "IfNotPresent",
      nodeSelector: { "ci.gdario.dev/android-kvm": "true" },
      podSecurityContext: {
        // Hermes services drop to GID 10000 after s6 initialization, so the PVCs need a
        // Kubernetes-managed group instead of relying on root-owned legacy directories.
        fsGroup: 10000,
        fsGroupChangePolicy: "OnRootMismatch",
        supplementalGroups: [990],
      },
      containerSecurityContext: { privileged: false },
      endpoints: [
        {
          name: "http",
          containerPort: 9119,
          servicePort: 80,
          ingress: { name: "hermes-agent", host: hermesIdentity.host },
        },
        {
          name: "api",
          containerPort: 8642,
          servicePort: 8642,
          ingress: { name: "hermes-agent-api", host: "hermes-api.gdario.dev" },
        },
      ],
      settings,
      env: [{
        // ConfigMap envFrom does not replace the image's PATH, so this must be an explicit env var.
        name: "PATH",
        value: "/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/emulator:/opt/android-sdk/platform-tools:/usr/local/bin:/opt/data/profiles/engineer/home/.local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin",
      }, {
        name: "ANDROID_HOME",
        value: "/opt/android-sdk",
      }, {
        name: "ANDROID_SDK_ROOT",
        value: "/opt/android-sdk",
      }, {
        name: "ANDROID_AVD_HOME",
        value: "/opt/android-data/avd",
      }, {
        name: "GRADLE_USER_HOME",
        value: "/opt/android-data/gradle",
      }],
      labels: {
        [Labels.Network.AllowAuthentik]: "true",
      },
      args: ["gateway", "run"],
      strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } },
      ipFamilyPolicy: "SingleStack",
      ipFamilies: ["IPv4"],
      resources: {
        limits: { cpu: "4", memory: "12Gi", "devic.es/kvm": "1" },
        requests: { cpu: "500m", memory: "2Gi", "devic.es/kvm": "1" },
      },
      volumes: [{
        name: "data",
        mountPath: "/opt/data",
        size: "256Mi",
        pvcName: "hermes-agent-pvc",
      }, {
        name: "android",
        mountPath: "/opt/android-data",
        size: "20Gi",
        enableBackup: false,
      }],
      additionalContainers: [{
        name: "dind",
        image: "docker:26-dind",
        securityContext: { privileged: true },
        env: [{ name: "DOCKER_TLS_CERTDIR", value: "" }],
        volumeMounts: [{ name: "docker-graph-storage", mountPath: "/var/lib/docker" }],
      }],
      additionalVolumes: [
        { name: "docker-graph-storage", emptyDir: {} },
        {
          name: "kube-api-access",
          projected: {
            defaultMode: 0o644,
            sources: [
              { serviceAccountToken: { path: "token", expirationSeconds: 3600 } },
              { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } },
              { downwardAPI: { items: [{ path: "namespace", fieldRef: { fieldPath: "metadata.namespace" } }] } },
            ],
          },
        },
      ],
      additionalVolumeMounts: [{
        name: "kube-api-access",
        mountPath: "/var/run/secrets/kubernetes.io/serviceaccount",
        readOnly: true,
      }],
    },
  });
}
