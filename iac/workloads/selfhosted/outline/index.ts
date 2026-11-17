import { outlineIdentity } from "./identity";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp } from "../../../library/selfhosted-component";
import { secureWorkloadContainer, workloadPodSecurityContext } from "../../../library/workload-security";
import { Labels } from "../labels";
import { outlineMinioSettings, outlineRedisSettings, outlineSettings } from "./settings";

const minioImage = "minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";

export function configureOutline(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "outline";
  // Redis
  const redis = new SelfhostedApp(`${name}-redis`, {
    namespace,
    image: "redis:7-alpine",
    // Redis fixes existing data ownership before switching to its service user.
    containerSecurityContext: { capabilities: { add: ["CHOWN", "SETUID", "SETGID"] } },
    settings: outlineRedisSettings,
    endpoints: [{ name: "http", servicePort: 80, containerPort: 6379, allowIngressFrom: [{ podSelector: { app: name }, port: 6379 }] }],
    volumes: [
      {
        name: "redis-data",
        mountPath: "/data",
        size: "1Gi",
      }
    ],
    dependencies,
  });

  // MinIO
  const minio = new SelfhostedApp(`${name}-minio`, {
    namespace,
    image: minioImage,
    imagePullPolicy: "IfNotPresent",
    settings: outlineMinioSettings,
    endpoints: [{
      name: "http",
      servicePort: 80,
      containerPort: 9000,
      allowIngressFrom: [
        { podSelector: { app: name } },
        // Job-created pod labels also cover retries without changing the Job template.
        { name: "setup", podSelector: { "batch.kubernetes.io/job-name": `${name}-minio-setup` } },
      ],
    }],
    args: ["server", "/data"],
    volumes: [
      {
        name: "minio-data",
        mountPath: "/data",
        size: "10Gi",
      },
    ],
    dependencies,
  });

  // MinIO Setup Job
  const minioSetup = new k8s.batch.v1.Job(`${name}-minio-setup`, {
    metadata: { name: `${name}-minio-setup`, namespace },
    spec: {
      template: {
        spec: {
          securityContext: workloadPodSecurityContext(),
          containers: [secureWorkloadContainer({
            name: "mc",
            // This server image includes mc; the separate minio/mc repository
            // no longer pulls. Reuse the existing image without upgrading storage.
            image: minioImage,
            env: [
              { name: "MINIO_ROOT_PASSWORD", value: outlineMinioSettings.secrets["MINIO_ROOT_PASSWORD"] }
            ],
            command: ["/bin/bash", "-c", `
              sleep 10;
              mc alias set myminio http://outline-minio.selfhosted.svc.cluster.local:80 minioadmin $MINIO_ROOT_PASSWORD;
              mc mb myminio/outline || true;
              mc anonymous set public myminio/outline;
            `]
          })],
          restartPolicy: "OnFailure"
        }
      }
    }
  }, { dependsOn: [minio.deployment] });

  // Outline Web App
  const outline = new SelfhostedApp(name, {
    namespace,
    image: "outlinewiki/outline:1.13.0",
    resources: { requests: { cpu: "25m", memory: "384Mi" }, limits: { memory: "768Mi" } },
    endpoints: [{
      name: "http",
      servicePort: 80,
      containerPort: 3000,
      ingress: { name: "outline", host: outlineIdentity.host },
      healthCheck: { protocol: "tcp" },
      allowIngressFrom: [{
        podSelector: { app: "outline-mcp" },
        namespaceSelector: { "kubernetes.io/metadata.name": "agent-sidekicks" },
      }],
    }],
    ipFamilyPolicy: "SingleStack",
    ipFamilies: ["IPv6"],
    labels: {
      [Labels.Network.AllowPostgres]: "true",
    },
    settings: outlineSettings,
    dependencies: [minioSetup, redis.deployment, ...dependencies],
  });

  return {
    redis,
    minio,
    outline,
  };
}
