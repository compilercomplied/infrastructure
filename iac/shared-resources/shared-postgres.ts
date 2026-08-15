import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createPVC } from "../library/k8s-pvc";
import { Labels } from "../selfhosted/labels";

export const postgresClientImage = "postgres:16-alpine";

export interface PostgresDatabaseArgs {
  name: string;
  password: pulumi.Input<string>;
}

export function configureSharedPostgres(
  namespace: pulumi.Input<string>,
  databases: PostgresDatabaseArgs[],
  dependencies: pulumi.Resource[] = []
) {
  const config = new pulumi.Config("selfhosted");
  const postgresPassword = config.requireSecret("postgresPassword");

  const name = "shared-postgres";

  // Create PVC for database storage
  const pvc = createPVC({
    name: `${name}-pvc`,
    namespace,
    size: "10Gi",
    dependencies,
  });

  const initScripts: Record<string, pulumi.Output<string>> = {};
  databases.forEach((db, i) => {
    const fileIndex = String(i + 1).padStart(2, "0");
    initScripts[`${fileIndex}-init-${db.name}.sql`] = pulumi.interpolate`
        CREATE USER ${db.name} WITH PASSWORD '${db.password}';
        CREATE DATABASE ${db.name} OWNER ${db.name};
        GRANT ALL PRIVILEGES ON DATABASE ${db.name} TO ${db.name};
        \\c ${db.name}
        GRANT ALL ON SCHEMA public TO ${db.name};
      `;
  });

  // Create a secret containing database initialization scripts
  const initScriptSecret = new k8s.core.v1.Secret(`${name}-init-script`, {
    metadata: {
      name: `${name}-init-script`,
      namespace,
    },
    stringData: initScripts,
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
            name: "shared-postgres",
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

  // NetworkPolicy to allow PostgreSQL ingress only from pods with AllowPostgres capability label
  const postgresPolicy = new k8s.networking.v1.NetworkPolicy("allow-postgres-ingress", {
    metadata: {
      name: "allow-postgres-ingress",
      namespace,
    },
    spec: {
      podSelector: {
        matchLabels: {
          app: name,
        },
      },
      ingress: [
        {
          from: [
            {
              podSelector: {
                matchLabels: {
                  [Labels.Network.AllowPostgres]: "true",
                },
              },
            },
            {
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": "infrastructure",
                },
              },
              podSelector: {
                matchLabels: {
                  [Labels.Network.AllowPostgres]: "true",
                },
              },
            },
          ],
          ports: [{ port: 5432 }],
        },
      ],
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: service });

  return service;
}
