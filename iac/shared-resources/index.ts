import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { configureNamespaceSecurity } from "../selfhosted/security";
import { configureBridgePolicies } from "./bridge-network-policies";
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
  const litellmDbPassword = config.requireSecret("litellmDbPassword");
  const outlineDbPassword = config.requireSecret("outlineDbPassword");
  const grimmoryDbPassword = config.requireSecret("grimmoryDbPassword");

  const postgres = configureSharedPostgres(namespaceName, [
    { name: "tandoor", password: tandoorDbPassword },
    { name: "authentik", password: authentikDbPassword },
    { name: "linkwarden", password: linkwardenDbPassword },
    { name: "forgejo", password: forgejoDbPassword },
    { name: "litellm", password: litellmDbPassword },
    { name: "outline", password: outlineDbPassword },
  ], [namespace]);

  const mariadb = configureSharedMariaDb(namespaceName, [
    { name: "grimmory", password: grimmoryDbPassword },
  ], [namespace]);

  const security = configureNamespaceSecurity({
    namespace: namespaceName,
    dependencies: [namespace, postgres, mariadb],
    namePrefix: "shared-resources-",
  });

  // Pre-emptive bridge NetworkPolicy allowing other namespaces to connect 
  // to each other during the migration.
  const bridgeNamespaces = [
    "selfhosted", 
    "infrastructure", 
    "forgejo", 
    "agent-sidekicks", 
    "shared-resources",
    "agents-control-plane"
  ];
  
  const allowedNamespaces = [
    ...bridgeNamespaces,
    "monitoring",
    "kube-system"
  ];

  const bridgePolicies = configureBridgePolicies(bridgeNamespaces, allowedNamespaces);

  return {
    namespace: namespaceName,
    security,
    bridgePolicies,
    postgres,
    mariadb,
  };
}
