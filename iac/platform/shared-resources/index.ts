import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { configureNamespaceSecurity } from "../../workloads/selfhosted/security";
import { configureSharedPostgres } from "./shared-postgres";
import { configureSharedMariaDb } from "./shared-mariadb";

export function configureSharedResources() {
  const namespace = new k8s.core.v1.Namespace("shared-resources", {
    metadata: { name: "shared-resources" }
  });

  const namespaceName = namespace.metadata.name;

  const config = new pulumi.Config("selfhosted");
  const tandoorDbPassword = config.requireSecret("tandoorDbPassword");
  const authentikDbPassword = config.requireSecret("authentikDbPassword");
  const linkwardenDbPassword = config.requireSecret("linkwardenDbPassword");
  const forgejoDbPassword = config.requireSecret("forgejoDbPassword");
  const outlineDbPassword = config.requireSecret("outlineDbPassword");
  const grimmoryDbPassword = config.requireSecret("grimmoryDbPassword");
  const memosDbPassword = config.requireSecret("memosDbPassword");
  const excalidashDbPassword = config.requireSecret("excalidashDbPassword");

  const postgres = configureSharedPostgres(namespaceName, [
    { name: "tandoor", password: tandoorDbPassword },
    { name: "authentik", password: authentikDbPassword },
    { name: "linkwarden", password: linkwardenDbPassword },
    { name: "forgejo", password: forgejoDbPassword },
    { name: "outline", password: outlineDbPassword },
    { name: "memos", password: memosDbPassword },
    { name: "excalidash", password: excalidashDbPassword },
  ], [namespace]);

  const mariadb = configureSharedMariaDb(namespaceName, [
    { name: "grimmory", password: grimmoryDbPassword },
  ], [namespace]);

  const security = configureNamespaceSecurity({
    namespace: namespaceName,
    dependencies: [namespace, postgres, mariadb],
    namePrefix: "shared-resources-",
  });

  return {
    namespace: namespaceName,
    security,
    postgres,
    mariadb,
  };
}
