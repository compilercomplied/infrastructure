import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { postgresClientImage } from "../platform/shared-resources/shared-postgres";
import { Labels } from "../workloads/selfhosted/labels";

const sharedPostgresHost = "shared-postgres.shared-resources.svc.cluster.local";

export interface PostgresBootstrapArgs {
  name: string;
  namespace: pulumi.Input<string>;
  databasePassword: pulumi.Input<string>;
  adminPassword: pulumi.Input<string>;
  scriptPaths: string[];
  dependencies?: pulumi.Resource[];
  databaseName?: string;
  username?: string;
  host?: string;
  resourceNames?: {
    configMap?: string;
    secret?: string;
    job?: string;
    checksumAnnotation?: string;
  };
}

export function createPostgresBootstrap(args: PostgresBootstrapArgs): k8s.batch.v1.Job {
  const databaseName = args.databaseName ?? args.name;
  const username = args.username ?? args.name;
  const dependencies = args.dependencies ?? [];
  const resourceNames = {
    configMap: `${args.name}-db-init-scripts`,
    secret: `${args.name}-secrets-dbinit`,
    job: `init-${args.name}-db`,
    checksumAnnotation: "db-init-hash",
    ...args.resourceNames,
  };
  const scripts = Object.fromEntries(args.scriptPaths.map(scriptPath => [path.basename(scriptPath), fs.readFileSync(scriptPath, "utf8")]));

  if (Object.keys(scripts).length !== args.scriptPaths.length) {
    throw new Error(`PostgreSQL bootstrap scripts for ${args.name} must have unique basenames`);
  }
  if (!("postgres_bootstrap.sql" in scripts)) {
    throw new Error(`PostgreSQL bootstrap scripts for ${args.name} must include postgres_bootstrap.sql`);
  }

  const scriptConfigMap = new k8s.core.v1.ConfigMap(resourceNames.configMap, {
    metadata: { name: resourceNames.configMap, namespace: args.namespace },
    data: scripts,
  }, { dependsOn: dependencies });
  const bootstrapSecret = new k8s.core.v1.Secret(resourceNames.secret, {
    metadata: { name: resourceNames.secret, namespace: args.namespace },
    stringData: {
      DB_PASSWORD: args.databasePassword,
      ADMIN_PASSWORD: args.adminPassword,
    },
  }, { dependsOn: dependencies });
  const checksum = pulumi.all([args.databasePassword, args.adminPassword, pulumi.output(scripts)]).apply(([databasePassword, adminPassword, resolvedScripts]) =>
    crypto.createHash("sha256").update(databasePassword + adminPassword + JSON.stringify(Object.entries(resolvedScripts).sort(([left], [right]) => left.localeCompare(right)))).digest("hex"));

  return new k8s.batch.v1.Job(resourceNames.job, {
    metadata: { namespace: args.namespace, annotations: { [resourceNames.checksumAnnotation]: checksum } },
    spec: {
      template: {
        metadata: {
          labels: { [Labels.Network.AllowPostgres]: "true" },
          annotations: { [resourceNames.checksumAnnotation]: checksum },
        },
        spec: {
          restartPolicy: "Never",
          containers: [{
            name: "db-init",
            image: postgresClientImage,
            command: ["/bin/sh", "-ec", `
              export PGPASSWORD="$ADMIN_PASSWORD"
              for attempt in $(seq 1 30); do
                if psql -h "$DB_HOST" -U postgres -d postgres -c "SELECT 1" >/dev/null 2>&1; then
                  psql --set=ON_ERROR_STOP=1 -h "$DB_HOST" -U postgres -d postgres \\
                    -v db_name="$DB_NAME" -v db_user="$DB_USER" -v db_password="$DB_PASSWORD" \\
                    -f /scripts/postgres_bootstrap.sql
                  for script in /scripts/*.sql; do
                    [ "$script" = /scripts/postgres_bootstrap.sql ] && continue
                    psql --set=ON_ERROR_STOP=1 -h "$DB_HOST" -U postgres -d postgres \\
                      -v db_name="$DB_NAME" -v db_user="$DB_USER" -v db_password="$DB_PASSWORD" \\
                      -f "$script"
                  done
                  exit 0
                fi
                sleep 2
              done
              echo "PostgreSQL did not become ready within 60 seconds" >&2
              exit 1
            `],
            env: [
              { name: "DB_HOST", value: args.host ?? sharedPostgresHost },
              { name: "DB_NAME", value: databaseName },
              { name: "DB_USER", value: username },
              { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: bootstrapSecret.metadata.name, key: "DB_PASSWORD" } } },
              { name: "ADMIN_PASSWORD", valueFrom: { secretKeyRef: { name: bootstrapSecret.metadata.name, key: "ADMIN_PASSWORD" } } },
            ],
            volumeMounts: [{ name: "scripts", mountPath: "/scripts", readOnly: true }],
          }],
          volumes: [{ name: "scripts", configMap: { name: scriptConfigMap.metadata.name, defaultMode: 0o755 } }],
        },
      },
    },
  }, {
    dependsOn: [scriptConfigMap, bootstrapSecret, ...dependencies],
    replaceOnChanges: ["metadata.annotations"],
    deleteBeforeReplace: true,
  });
}
