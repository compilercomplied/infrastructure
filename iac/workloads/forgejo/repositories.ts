import * as pulumi from "@pulumi/pulumi";
import { createRepositoryFactory } from "./policy";

export function configureRepositories(dependencies: pulumi.Resource[] = []) {
  const createRepo = createRepositoryFactory(dependencies);

  return [
    createRepo({ name: "homelab-iac" }),
    createRepo({ name: "game-launcher", isPublic: false }),
    createRepo({ name: "repo-template" }),
    createRepo({ name: "tandoor-mcp" }),
    createRepo({ name: "agent-dev-environment" }),
  ];
}
