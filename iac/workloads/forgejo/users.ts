import * as pulumi from "@pulumi/pulumi";
import { ForgejoOidcUser } from "./oidc-user";

export const forgejoUserLogins = {
  dario: "dario", codingBot: "coding-bot", reviewingBot: "reviewing-bot",
  codex: "agent-codex", hermes: "agent-hermes", openclaw: "agent-openclaw", renovate: "renovate",
} as const;

export type ManagedForgejoUsers = Record<keyof typeof forgejoUserLogins, ForgejoOidcUser>;

export function reconcileManagedForgejoUsers(
  host: pulumi.Input<string>,
  adminToken: pulumi.Input<string>,
  subjects: Record<keyof ManagedForgejoUsers, pulumi.Input<string>>,
  dependencies: pulumi.Resource[] = [],
): ManagedForgejoUsers {
  const sourceId = new pulumi.Config("forgejo").requireNumber("keycloakSourceId");
  const humanEmail = new pulumi.Config("selfhosted").requireSecret("user-gdario-email");
  return Object.fromEntries(Object.entries(forgejoUserLogins).map(([name, login]) => [
    name,
    new ForgejoOidcUser(`forgejo-${login}-user`, {
      host, adminToken, login, sourceId, loginName: subjects[name as keyof ManagedForgejoUsers],
      email: name === "dario" ? humanEmail : `${login}@gdario.dev`,
      fullName: name === "renovate" ? "Renovate" : login.startsWith("agent-") ? login : "",
      active: true, admin: name === "dario", restricted: name === "renovate",
      visibility: name === "renovate" ? "private" : "public",
      allowCreateOrganization: ["dario", "codingBot", "reviewingBot"].includes(name),
      allowGitHook: false, allowImportLocal: false,
      maxRepoCreation: name === "renovate" ? 0 : -1,
      mustChangePassword: false, prohibitLogin: false,
    }, { dependsOn: dependencies }),
  ])) as ManagedForgejoUsers;
}
