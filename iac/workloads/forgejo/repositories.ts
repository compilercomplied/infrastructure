import * as pulumi from "@pulumi/pulumi";
import { ManagedForgejoUsers } from "./users";
import { createRepositoryFactory } from "./policy";

export function configureRepositories(host: pulumi.Input<string>, users: ManagedForgejoUsers, dependencies: pulumi.Resource[] = []) {
  const createRepo = createRepositoryFactory(host, users, dependencies);

  return [
    createRepo({ name: "homelab-iac" }),
    createRepo({ name: "mood-tracker", isPublic: false }),
    createRepo({ name: "game-launcher", isPublic: false }),
    createRepo({ name: "repo-template" }),
    createRepo({ name: "forgejo-workflow-templates", isPublic: true, requiredStatusChecks: [] }),
    createRepo({ name: "tandoor-mcp" }),
    createRepo({ name: "agent-dev-environment" }),
    createRepo({ name: "hitl-auth-server" }),
  ];
}
