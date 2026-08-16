import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { configureNamespaceSecurity } from "../selfhosted/security";

import { configureForgejo as configureForgejoApp } from "./forgejo";
import { configureForgejoRunner } from "./forgejo-runner";


export function configureForgejo(dependencies: pulumi.Resource[] = []) {
  const namespace = new k8s.core.v1.Namespace("forgejo", {
    metadata: { name: "forgejo" }
  }, { dependsOn: dependencies });

  const namespaceName = namespace.metadata.name;

  const forgejoApp = configureForgejoApp(namespaceName, [...dependencies, namespace]);
  const forgejoRunner = configureForgejoRunner(namespaceName, forgejoApp.runnerSecret, [forgejoApp.deployment, namespace]);

  const security = configureNamespaceSecurity({
    namespace: namespaceName,
    dependencies: [namespace, forgejoApp.deployment, forgejoRunner.deployment],
    namePrefix: "forgejo-",
  });

  return {
    namespace: namespaceName,
    security,
    forgejoApp,
    forgejoRunner,
  };
}
