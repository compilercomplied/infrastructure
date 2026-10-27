import * as forgejo from "@pulumi/forgejo";
import * as pulumi from "@pulumi/pulumi";
import { managedForgejoMachineUsers } from "./users";

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
  dependencies: pulumi.Resource[] = [],
) {
  const repository = forgejo.getRepositoryOutput({ owner: "home", name: "homelab-iac" }, { provider });
  const collaborator = new forgejo.Collaborator("forgejo-renovate-homelab-iac", {
    repositoryId: repository.id,
    user: renovate.login,
    permission: "write",
  }, { provider, protect: true, dependsOn: dependencies });
  const token = new forgejo.PersonalAccessToken("forgejo-renovate-token", {
    name: managedForgejoMachineUsers.renovate.login,
    user: renovate.login,
    scopes: renovateTokenScopes,
  }, { provider, protect: true, dependsOn: [renovate, collaborator] });

  return { collaborator, token };
}
