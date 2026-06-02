import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createLetsEncryptIngress } from "../library/ingress";

export function configureLinkwarden(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config("selfhosted");
  const linkwardenDbPassword = config.requireSecret("linkwardenDbPassword");
  const linkwardenSecret = config.requireSecret("linkwarden-secret");
  const linkwardenNextAuthSecret = config.requireSecret("linkwardenNextAuthSecret");

  const name = "linkwarden";

  const pvc = new k8s.core.v1.PersistentVolumeClaim(`${name}-pvc`, {
    metadata: {
      name: `${name}-pvc`,
      namespace,
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: "local-path",
      resources: {
        requests: {
          storage: "10Gi",
        },
      },
    },
  }, { dependsOn: dependencies });

  const linkwardenSecrets = new k8s.core.v1.Secret(`${name}-secrets`, {
    metadata: {
      name: `${name}-secrets`,
      namespace,
    },
    stringData: {
      "NEXTAUTH_SECRET": linkwardenNextAuthSecret,
      "POSTGRES_PASSWORD": linkwardenDbPassword,
      "AUTHENTIK_CLIENT_SECRET": linkwardenSecret,
    },
  }, { dependsOn: dependencies });

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
          containers: [{
            name: name,
            image: "ghcr.io/linkwarden/linkwarden:v2.14.1",
            ports: [{ containerPort: 3000, name: "http" }],
            env: [
              { name: "DATABASE_URL", value: pulumi.interpolate`postgresql://linkwarden:${linkwardenDbPassword}@shared-postgres.selfhosted.svc.cluster.local:5432/linkwarden` },
              { name: "NEXTAUTH_URL", value: "https://linkwarden.gdario.dev/api/v1/auth" },
              { name: "NEXT_PUBLIC_AUTHENTIK_ENABLED", value: "true" },
              { name: "AUTHENTIK_CUSTOM_NAME", value: "authentik" },
              { name: "AUTHENTIK_ISSUER", value: "https://auth.gdario.dev/application/o/linkwarden" },
              { name: "AUTHENTIK_CLIENT_ID", value: "linkwarden-client-id" },
              {
                name: "NEXTAUTH_SECRET",
                valueFrom: {
                  secretKeyRef: {
                    name: linkwardenSecrets.metadata.name,
                    key: "NEXTAUTH_SECRET",
                  },
                },
              },
              {
                name: "AUTHENTIK_CLIENT_SECRET",
                valueFrom: {
                  secretKeyRef: {
                    name: linkwardenSecrets.metadata.name,
                    key: "AUTHENTIK_CLIENT_SECRET",
                  },
                },
              },
            ],
            volumeMounts: [
              {
                name: "linkwarden-data",
                mountPath: "/data/data",
              },
            ],
          }],
          volumes: [
            {
              name: "linkwarden-data",
              persistentVolumeClaim: {
                claimName: pvc.metadata.name,
              },
            },
          ],
        },
      },
    },
  }, { dependsOn: [pvc, linkwardenSecrets, ...dependencies] });

  const service = new k8s.core.v1.Service(name, {
    metadata: {
      name,
      namespace,
      annotations: {
        "tailscale.com/expose": "true",
        "tailscale.com/hostname": name,
        "tailscale.com/tags": "tag:kubernetes",
      },
    },
    spec: {
      ports: [{ port: 80, targetPort: 3000, protocol: "TCP", name: "http" }],
      selector: { app: name },
    },
  }, { dependsOn: deployment });

  const ingress = createLetsEncryptIngress({
    name,
    namespace,
    host: "linkwarden.gdario.dev",
    serviceName: service.metadata.name,
    dependencies: [service],
  });

  return { service, ingress };
}
