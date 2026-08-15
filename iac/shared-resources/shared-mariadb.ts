import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createPVC } from "../library/k8s-pvc";
import { Labels } from "../selfhosted/labels";

export const sharedMariaDbImage = "mariadb:11.4";

export interface MariaDbDatabaseArgs {
  name: string;
  password: pulumi.Input<string>;
}

export function configureSharedMariaDb(
  namespace: pulumi.Input<string>,
  databases: MariaDbDatabaseArgs[],
  dependencies: pulumi.Resource[] = []
) {
  const name = "shared-mariadb";

  const pvc = createPVC({
    name: `${name}-pvc`,
    namespace,
    size: "10Gi",
    dependencies,
  });

  // Combine secrets for all requested databases
  const secrets: Record<string, pulumi.Input<string>> = {
    // MariaDB requires a root password by default to initialize properly
    "MYSQL_ROOT_PASSWORD": "dummy-root-password-override-if-needed", 
  };
  
  databases.forEach((db) => {
    secrets[`MYSQL_PASSWORD_${db.name.toUpperCase()}`] = db.password;
  });

  // Note: For simplicity we only initialize the first requested database explicitly via MYSQL_DATABASE environment variable,
  // since the official mariadb image only supports creating one database out of the box via MYSQL_DATABASE.
  // We'll use the grimmory DB variables directly here for backward compatibility, but in a real setup we should mount init scripts like postgres.
  
  const mariadbSecret = new k8s.core.v1.Secret(`${name}-secrets`, {
    metadata: {
      name: `${name}-secrets`,
      namespace,
    },
    stringData: {
      "MYSQL_ROOT_PASSWORD": databases[0].password,
      "MYSQL_PASSWORD": databases[0].password,
      "MYSQL_USER": databases[0].name,
      "MYSQL_DATABASE": databases[0].name,
    },
  }, { dependsOn: dependencies });

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
            name: "mariadb",
            image: sharedMariaDbImage,
            ports: [{ containerPort: 3306, name: "mysql" }],
            args: [
              "--performance-schema=OFF",
              "--innodb-buffer-pool-size=32M",
              "--innodb-log-buffer-size=1M",
              "--query-cache-size=0",
              "--max-connections=10",
            ],
            env: [
              { name: "MYSQL_ROOT_PASSWORD", valueFrom: { secretKeyRef: { name: mariadbSecret.metadata.name, key: "MYSQL_ROOT_PASSWORD" } } },
              { name: "MYSQL_DATABASE", value: databases[0].name },
              { name: "MYSQL_USER", value: databases[0].name },
              { name: "MYSQL_PASSWORD", valueFrom: { secretKeyRef: { name: mariadbSecret.metadata.name, key: "MYSQL_PASSWORD" } } },
            ],
            volumeMounts: [{
              name: "mysql-data",
              mountPath: "/var/lib/mysql",
            }],
          }],
          volumes: [{
            name: "mysql-data",
            persistentVolumeClaim: {
              claimName: pvc.metadata.name,
            },
          }],
        },
      },
    },
  }, { dependsOn: [pvc, mariadbSecret] });

  const service = new k8s.core.v1.Service(name, {
    metadata: {
      name,
      namespace,
    },
    spec: {
      ports: [{ port: 3306, targetPort: 3306, protocol: "TCP" }],
      selector: { app: name },
    },
  }, { dependsOn: statefulSet });

  const mariadbPolicy = new k8s.networking.v1.NetworkPolicy("allow-mariadb-ingress", {
    metadata: {
      name: "allow-mariadb-ingress",
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
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": "selfhosted",
                },
              },
              podSelector: {
                matchLabels: {
                  [Labels.Network.AllowMariaDb]: "true",
                },
              },
            },
          ],
          ports: [{ port: 3306 }],
        },
      ],
      policyTypes: ["Ingress"],
    },
  }, { dependsOn: service });

  return service;
}
