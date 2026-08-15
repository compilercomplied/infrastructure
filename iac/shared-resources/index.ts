import * as k8s from "@pulumi/kubernetes";
import { configureNamespaceSecurity } from "../selfhosted/security";
import { configureBridgePolicies } from "./bridge-network-policies";

export function configureSharedResources() {
  const namespace = new k8s.core.v1.Namespace("shared-resources", {
    metadata: { name: "shared-resources" }
  });

  const namespaceName = namespace.metadata.name;

  const security = configureNamespaceSecurity({
    namespace: namespaceName,
    dependencies: [namespace],
    namePrefix: "shared-resources-",
  });

  // Pre-emptive bridge NetworkPolicy allowing other namespaces to connect 
  // to each other during the migration.
  const bridgePolicies = configureBridgePolicies([
    "selfhosted", 
    "infrastructure", 
    "forgejo", 
    "agent-sidekicks", 
    "shared-resources",
    "agents-control-plane"
  ]);

  return {
    namespace: namespaceName,
    security,
    bridgePolicies,
  };
}
