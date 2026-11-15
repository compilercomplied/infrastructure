import * as forgejo from "@pulumi/forgejo";
import * as pulumi from "@pulumi/pulumi";
import { ForgejoAdminToken } from "./admin-token";
import { forgejoIdentity } from "./app/identity";
import { ForgejoOidcUser } from "./oidc-user";

export function configureRegistryAccess(
  provider: forgejo.Provider,
  publisher: ForgejoOidcUser,
  adminToken: pulumi.Input<string>,
  dependencies: pulumi.Resource[],
) {
  const token = new ForgejoAdminToken("forgejo-home-registry-token", {
    host: forgejoIdentity.url,
    adminToken,
    user: publisher.login,
    name: "home-registry-ci",
    scopes: ["write:package"],
  }, { protect: true, dependsOn: [publisher, ...dependencies] });
  const options = { provider, protect: true, dependsOn: dependencies };
  const secret = new forgejo.OrganizationActionSecret("forgejo-home-registry-secret", {
    organization: "home", name: "REGISTRY_TOKEN", data: token.token,
  }, options);
  // The publisher identity is independent of the person or agent triggering a workflow.
  const username = new forgejo.OrganizationActionVariable("forgejo-home-registry-username", {
    organization: "home", name: "REGISTRY_USERNAME", data: publisher.login,
  }, options);
  return { token, secret, username };
}
