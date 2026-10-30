import * as forgejo from "@pulumi/forgejo";
import * as pulumi from "@pulumi/pulumi";
import { managedForgejoMachineUsers } from "./users";
import { ForgejoAdminToken } from "./admin-token";
import { forgejoIdentity } from "./app/identity";

const renovateTokenScopes = [
  "read:user",
  "read:organization",
  "read:repository",
  "write:repository",
  "read:issue",
  "write:issue",
  "read:package",
];

export function provisionRenovateAccess(
  provider: forgejo.Provider,
  renovate: forgejo.User,
  adminToken: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = [],
) {
  const repository = forgejo.getRepositoryOutput({ owner: "home", name: "homelab-iac" }, { provider });
  const collaborator = new forgejo.Collaborator("forgejo-renovate-homelab-iac", {
    repositoryId: repository.id,
    user: renovate.login,
    permission: "write",
  }, { provider, protect: true, dependsOn: dependencies });
  const token = new ForgejoAdminToken("forgejo-renovate-token", {
    host: forgejoIdentity.url,
    adminToken,
    name: managedForgejoMachineUsers.renovate.login,
    user: renovate.login,
    scopes: renovateTokenScopes,
  }, { protect: true, dependsOn: [renovate, collaborator] });

  return { collaborator, token };
}
