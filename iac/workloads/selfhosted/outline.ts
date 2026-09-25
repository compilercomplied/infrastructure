import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { SelfhostedApp } from "../../library/selfhosted-component";
import { Labels } from "./labels";
import { outlineMinioSettings, outlineRedisSettings, outlineSettings } from "./outline-settings";

export function configureOutline(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const name = "outline";
  // Redis
  const redis = new SelfhostedApp(`${name}-redis`, {
    namespace,
    image: "redis:7-alpine",
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
    image: "minio/minio:latest",
    settings: outlineMinioSettings,
    endpoints: [{ name: "http", servicePort: 80, containerPort: 9000, allowIngressFrom: [{ podSelector: { app: name }, port: 9000 }] }],
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
          containers: [{
            name: "mc",
            image: "minio/mc:latest",
            env: [
              { name: "MINIO_ROOT_PASSWORD", value: outlineMinioSettings.secrets["MINIO_ROOT_PASSWORD"] }
            ],
            command: ["/bin/bash", "-c", `
              sleep 10;
              mc alias set myminio http://outline-minio.selfhosted.svc.cluster.local:80 minioadmin $MINIO_ROOT_PASSWORD;
              mc mb myminio/outline || true;
              mc anonymous set public myminio/outline;
            `]
          }],
          restartPolicy: "OnFailure"
        }
      }
    }
  }, { dependsOn: [minio.deployment] });

  // Outline Web App
  const outline = new SelfhostedApp(name, {
    namespace,
    image: "outlinewiki/outline:latest",
    endpoints: [{
      name: "http",
      servicePort: 80,
      containerPort: 3000,
      ingress: { name: "outline", host: "outline.gdario.dev" },
      healthCheck: { protocol: "tcp" },
      allowIngressFrom: [{
        podSelector: { app: "outline-mcp" },
        namespaceSelector: { "kubernetes.io/metadata.name": "agent-sidekicks" },
      }],
    }],
    ipFamilyPolicy: "SingleStack",
    ipFamilies: ["IPv6"],
    labels: {
      [Labels.Network.AllowAuthentik]: "true",
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
