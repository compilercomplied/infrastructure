import * as pulumi from "@pulumi/pulumi";
import { HermesAgent } from "../../library/hermes-agent";
import { Labels } from "../selfhosted/labels";
import { getAuthorizedUsers } from "../selfhosted/users";
import { HermesAgentSettings } from "./hermes-agent-settings";

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
      image: "nousresearch/hermes-agent:latest",
      endpoints: [
        {
          name: "http",
          containerPort: 9119,
          servicePort: 80,
          ingress: { name: "hermes-agent", host: "hermes.gdario.dev" },
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
        value: "/opt/data/profiles/engineer/home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      }],
      labels: {
        [Labels.Network.AllowAuthentik]: "true",
      },
      args: ["gateway", "run"],
      strategy: { type: "RollingUpdate" },
      ipFamilyPolicy: "SingleStack",
      ipFamilies: ["IPv4"],
      resources: {
        limits: { memory: "6Gi" },
        requests: { memory: "2Gi" },
      },
      volumes: [{
        name: "data",
        mountPath: "/opt/data",
        size: "256Mi",
        pvcName: "hermes-agent-pvc",
      }, {
        // Retain development data until its disposal is explicitly approved, but do not expose
        // it to Hermes while direct emulator execution is disabled on this shared host.
        name: "android",
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
