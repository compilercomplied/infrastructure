import * as crypto from "crypto";
import * as forgejo from "@pulumi/forgejo";
import * as pulumi from "@pulumi/pulumi";

interface ManagedMachineUserDefinition {
  resourceName: string;
  login: string;
  fullName: string;
  email: string;
  passwordSalt: string;
  security: Omit<forgejo.UserArgs, "login" | "fullName" | "email" | "password">;
}

// Human accounts are bootstrapped by Forgejo/OIDC and deliberately stay outside Pulumi reconciliation.
export const externallyManagedForgejoUsers = ["dario"] as const;

export const managedForgejoMachineUsers = {
  renovate: {
    resourceName: "forgejo-renovate-user",
    login: "renovate",
    fullName: "Renovate",
    email: "renovate@gdario.dev",
    passwordSalt: "renovate-bot-v1",
    security: {
      admin: false,
      allowCreateOrganization: false,
      allowGitHook: false,
      allowImportLocal: false,
      maxRepoCreation: 0,
      mustChangePassword: false,
      prohibitLogin: false,
      restricted: true,
      sendNotify: false,
      visibility: "private",
    },
  },
} as const satisfies Record<string, ManagedMachineUserDefinition>;

type ManagedMachineUsers = {
  [Name in keyof typeof managedForgejoMachineUsers]: forgejo.User;
};

export function reconcileManagedForgejoMachineUsers(
  provider: forgejo.Provider,
  passwordSeed: pulumi.Input<string>,
  dependencies: pulumi.Resource[] = [],
): ManagedMachineUsers {
  return Object.fromEntries(Object.entries(managedForgejoMachineUsers).map(([name, definition]) => [
    name,
    new forgejo.User(definition.resourceName, {
      login: definition.login,
      fullName: definition.fullName,
      email: definition.email,
      password: pulumi.secret(pulumi.output(passwordSeed).apply(seed =>
        crypto.createHash("sha256").update(`${seed}:${definition.passwordSalt}`).digest("hex")
      )),
      ...definition.security,
    }, { provider, protect: true, dependsOn: dependencies }),
  ])) as ManagedMachineUsers;
}
