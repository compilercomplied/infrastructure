import * as pulumi from "@pulumi/pulumi";

export interface UserDefinition {
  name: string;
  email: pulumi.Output<string>;
  telegramId: pulumi.Output<string>;
}

export interface GroupDefinition {
  name: string;
  members: string[];
}

export function getAuthorizedUsers(): UserDefinition[] {
  const config = new pulumi.Config("selfhosted");
  return [
    {
      name: "gdario",
      email: config.requireSecret("user-gdario-email"),
      telegramId: config.requireSecret("user-gdario-telegramId"),
    },
    {
      name: "Andrea",
      email: config.requireSecret("user-andrea-email"),
      telegramId: config.requireSecret("user-andrea-telegramId"),
    },
  ];
}

export function getGroupDefinitions(usernames: string[]): GroupDefinition[] {
  return [
    {
      name: "hermes-users",
      members: usernames,
    },
    {
      name: "grafana-admins",
      members: ["gdario"],
    },
    {
      name: "litellm-admins",
      members: ["gdario"],
    },
  ];
}
