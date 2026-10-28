import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as forgejo from "@pulumi/forgejo";
import { configureNamespaceSecurity } from "../selfhosted/security";

import { provisionRenovateAccess } from "./access";
import { configureForgejo as configureForgejoApp } from "./app";
import { forgejoIdentity } from "./app/identity";
import { configureForgejoRunner } from "./runner";
import { configureForgejoAndroidRunner } from "./android-runner";
import { configureRenovate } from "./renovate";
import { configureReviewWebhook } from "./review-webhook";
import { reconcileManagedForgejoMachineUsers } from "./users";

export function configureForgejo(dependencies: pulumi.Resource[] = []) {
  const namespace = new k8s.core.v1.Namespace("forgejo", {
    metadata: { name: "forgejo" }
  }, { dependsOn: dependencies });

  const namespaceName = namespace.metadata.name;

  const forgejoApp = configureForgejoApp(namespaceName, [...dependencies, namespace]);
  const config = new pulumi.Config("forgejo");
  const selfhosted = new pulumi.Config("selfhosted");
  const provider = new forgejo.Provider("forgejo-renovate", {
    host: forgejoIdentity.url,
    apiToken: config.requireSecret("apiToken"),
  }, { dependsOn: [forgejoApp.deployment, namespace, ...dependencies] });
  const users = reconcileManagedForgejoMachineUsers(
    provider,
    selfhosted.requireSecret("forgejo-secret"),
    [forgejoApp.deployment, namespace, ...dependencies],
  );
  const renovateAccess = provisionRenovateAccess(provider, users.renovate, config.requireSecret("apiToken"), [forgejoApp.deployment, namespace, ...dependencies]);
  const forgejoRunner = configureForgejoRunner(namespaceName, forgejoApp.runnerSecret, [forgejoApp.deployment, namespace]);
  const forgejoAndroidRunner = configureForgejoAndroidRunner(namespaceName, forgejoApp.androidRunnerSecret, [forgejoApp.deployment, namespace]);
  const reviewWebhook = configureReviewWebhook(config.requireSecret("apiToken"), [forgejoApp.deployment, namespace, ...dependencies]);
  const renovate = configureRenovate(namespaceName, renovateAccess.token.token, [forgejoApp.deployment, namespace, renovateAccess.token]);

  const security = configureNamespaceSecurity({
    namespace: namespaceName,
    dependencies: [namespace, forgejoApp.deployment, forgejoRunner.deployment, forgejoAndroidRunner.deployment, forgejoAndroidRunner.networkPolicy],
    namePrefix: "forgejo-",
  });

  return {
    namespace: namespaceName,
    security,
    forgejoApp,
    forgejoRunner,
    forgejoAndroidRunner,
    users,
    renovateAccess,
    reviewWebhook,
    renovate,
  };
}
