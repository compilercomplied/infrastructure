import { createHmac } from "node:crypto";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ForgejoAdminToken } from "./admin-token";
import { forgejoIdentity } from "./app/identity";
import { ForgejoOidcUser } from "./oidc-user";

export function configureSignalRouterCodingAccess(
  codingBot: ForgejoOidcUser,
  adminToken: pulumi.Input<string>,
  repositories: pulumi.Resource[],
) {
  const repository = { owner: "home", name: "signal-router" };
  const router = new pulumi.StackReference("signal-router", { name: "gdariodev/signal-router/prod" });
  const namespace = k8s.core.v1.Namespace.get("signal-router-coding-namespace", "agent-dev-environment");
  const token = new ForgejoAdminToken("signal-router-coding-bot-token", {
    host: forgejoIdentity.url,
    adminToken,
    user: codingBot.login,
    name: "signal-router-coding-automation",
    scopes: ["write:repository"],
    repositories: [repository],
  }, { protect: true, dependsOn: [codingBot, ...repositories] });

  // The coding bot inherits the Home Contributors role. Keep its API token in
  // the publisher sidecar so the model cannot use it to write to another repo.
  const homeToken = new ForgejoAdminToken("home-coding-bot-token", {
    host: forgejoIdentity.url,
    adminToken,
    user: codingBot.login,
    name: "home-coding-automation",
    scopes: ["write:repository", "read:user"],
  }, { protect: true, dependsOn: [codingBot, ...repositories] });

  new k8s.core.v1.Secret("home-coding-credential", {
    metadata: { name: "home-coding-credential", namespace: namespace.metadata.name },
    stringData: { token: homeToken.token },
  }, { protect: true });

  return new k8s.core.v1.Secret("signal-router-coding-automation", {
    metadata: { name: "coding-automation", namespace: namespace.metadata.name },
    stringData: {
      forgejo: token.token,
      repository: `${repository.owner}/${repository.name}`,
      router: router.requireOutput("signalRouterToken"),
      workspace: token.token.apply(value => createHmac("sha256", value).update("opencode-coding-workspace-v1").digest("hex")),
    },
  }, { protect: true });
}
