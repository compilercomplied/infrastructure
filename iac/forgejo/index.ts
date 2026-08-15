import * as k8s from "@pulumi/kubernetes";
import { configureNamespaceSecurity } from "../selfhosted/security";

export function configureForgejo() {
  const namespace = new k8s.core.v1.Namespace("forgejo", {
    metadata: { name: "forgejo" }
  });

  const namespaceName = namespace.metadata.name;

  const security = configureNamespaceSecurity({
    namespace: namespaceName,
    dependencies: [namespace],
    namePrefix: "forgejo-",
  });

  return {
    namespace: namespaceName,
    security,
  };
}
