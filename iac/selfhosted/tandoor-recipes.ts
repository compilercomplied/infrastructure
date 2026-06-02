import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createLetsEncryptIngress } from "../library/ingress";

export function configureTandoorRecipes(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config("selfhosted");
  const tandoorDbPassword = config.requireSecret("tandoorDbPassword");
  const tandoorSecretKey = config.requireSecret("tandoorSecretKey");
  const tandooriSecret = config.requireSecret("tandoori-secret");

  const name = "tandoor-recipes";

  const pvc = new k8s.core.v1.PersistentVolumeClaim(`${name}-media-pvc`, {
    metadata: {
      name: `${name}-media-pvc`,
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

  // Construct the SOCIALACCOUNT_PROVIDERS JSON string securely utilizing
	// Pulumi's Output interpolation
  const socialaccountProviders = pulumi.interpolate`{
    "openid_connect": {
      "SERVERS": [
        {
          "id": "authentik",
          "name": "Authentik",
          "server_url": "https://auth.gdario.dev/application/o/tandoor-recipes/.well-known/openid-configuration",
          "token_auth_method": "client_secret_basic",
          "APP": {
            "client_id": "tandoor-recipes-client-id",
            "secret": "${tandooriSecret}"
          }
        }
      ]
    }
  }`;

  const tandoorSecrets = new k8s.core.v1.Secret(`${name}-secrets`, {
    metadata: {
      name: `${name}-secrets`,
      namespace,
    },
    stringData: {
      "SECRET_KEY": tandoorSecretKey,
      "POSTGRES_PASSWORD": tandoorDbPassword,
      "SOCIALACCOUNT_PROVIDERS": socialaccountProviders,
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
            image: "ghcr.io/tandoorrecipes/recipes:2.6.9",
            ports: [{ containerPort: 8080, name: "http" }],
            env: [
              { name: "DB_ENGINE", value: "django.db.backends.postgresql" },
              { name: "POSTGRES_HOST", value: "shared-postgres.selfhosted.svc.cluster.local" },
              { name: "POSTGRES_PORT", value: "5432" },
              { name: "POSTGRES_DB", value: "tandoor" },
              { name: "POSTGRES_USER", value: "tandoor" },
              { name: "ALLOWED_HOSTS", value: "*" },
              { name: "TANDOOR_PORT", value: "8080" },
              { name: "SOCIAL_PROVIDERS", value: "allauth.socialaccount.providers.openid_connect" },
              {
                name: "SECRET_KEY",
                valueFrom: {
                  secretKeyRef: {
                    name: tandoorSecrets.metadata.name,
                    key: "SECRET_KEY",
                  },
                },
              },
              {
                name: "POSTGRES_PASSWORD",
                valueFrom: {
                  secretKeyRef: {
                    name: tandoorSecrets.metadata.name,
                    key: "POSTGRES_PASSWORD",
                  },
                },
              },
              {
                name: "SOCIALACCOUNT_PROVIDERS",
                valueFrom: {
                  secretKeyRef: {
                    name: tandoorSecrets.metadata.name,
                    key: "SOCIALACCOUNT_PROVIDERS",
                  },
                },
              },
            ],
            volumeMounts: [
              {
                name: "tandoor-media",
                mountPath: "/opt/recipes/mediafiles",
              },
            ],
          }],
          volumes: [
            {
              name: "tandoor-media",
              persistentVolumeClaim: {
                claimName: pvc.metadata.name,
              },
            },
          ],
        },
      },
    },
  }, { dependsOn: [pvc, tandoorSecrets, ...dependencies] });

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
      ports: [{ port: 80, targetPort: 8080, protocol: "TCP", name: "http" }],
      selector: { app: name },
    },
  }, { dependsOn: deployment });

  const ingress = createLetsEncryptIngress({
    name,
    namespace,
    host: "recipes.gdario.dev",
    serviceName: service.metadata.name,
    dependencies: [service],
  });

  return { service, ingress };
}

