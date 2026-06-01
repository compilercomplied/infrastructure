import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export function configureSharedPostgres(
  namespace: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config("selfhosted");
  const postgresPassword = config.requireSecret("postgresPassword");
  const tandoorDbPassword = config.requireSecret("tandoorDbPassword");
  const authentikDbPassword = config.requireSecret("authentikDbPassword");

  const name = "shared-postgres";

  // Create PVC for database storage
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

  // Create a secret containing database initialization scripts
  const initScriptSecret = new k8s.core.v1.Secret(`${name}-init-script`, {
    metadata: {
      name: `${name}-init-script`,
      namespace,
    },
    stringData: {
      "01-init-tandoor.sql": pulumi.interpolate`
        CREATE USER tandoor WITH PASSWORD '${tandoorDbPassword}';
        CREATE DATABASE tandoor OWNER tandoor;
        GRANT ALL PRIVILEGES ON DATABASE tandoor TO tandoor;
        \c tandoor
        GRANT ALL ON SCHEMA public TO tandoor;
      `,
      "02-init-authentik.sql": pulumi.interpolate`
        CREATE USER authentik WITH PASSWORD '${authentikDbPassword}';
        CREATE DATABASE authentik OWNER authentik;
        GRANT ALL PRIVILEGES ON DATABASE authentik TO authentik;
        \c authentik
        GRANT ALL ON SCHEMA public TO authentik;
      `
    },
  }, { dependsOn: dependencies });

  // PostgreSQL deployment secret for admin password
  const postgresSecret = new k8s.core.v1.Secret(`${name}-secrets`, {
    metadata: {
      name: `${name}-secrets`,
      namespace,
    },
    stringData: {
      "POSTGRES_PASSWORD": postgresPassword,
    },
  }, { dependsOn: dependencies });

  // StatefulSet for PostgreSQL (guarantees stable identity and single pod lock)
  const statefulSet = new k8s.apps.v1.StatefulSet(name, {
    metadata: {
      name,
      namespace,
    },
    spec: {
      serviceName: name,
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
            name: "postgres",
            image: "postgres:16-alpine",
            ports: [{ containerPort: 5432, name: "postgres" }],
            env: [
              {
                name: "POSTGRES_PASSWORD",
                valueFrom: {
                  secretKeyRef: {
                    name: postgresSecret.metadata.name,
                    key: "POSTGRES_PASSWORD",
                  },
                },
              },
              {
                name: "PGDATA",
                value: "/var/lib/postgresql/data/pgdata",
              },
            ],
            volumeMounts: [
              {
                name: "postgres-data",
                mountPath: "/var/lib/postgresql/data",
              },
              {
                name: "init-scripts",
                mountPath: "/docker-entrypoint-initdb.d",
              },
            ],
          }],
          volumes: [
            {
              name: "postgres-data",
              persistentVolumeClaim: {
                claimName: pvc.metadata.name,
              },
            },
            {
              name: "init-scripts",
              secret: {
                secretName: initScriptSecret.metadata.name,
              },
            },
          ],
        },
      },
    },
  }, { dependsOn: [pvc, initScriptSecret, postgresSecret] });

  // Service to expose PostgreSQL within the cluster
  const service = new k8s.core.v1.Service(name, {
    metadata: {
      name,
      namespace,
    },
    spec: {
      ports: [{ port: 5432, targetPort: 5432, protocol: "TCP" }],
      selector: { app: name },
    },
  }, { dependsOn: statefulSet });

  return service;
}
