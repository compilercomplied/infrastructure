import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { AppSettings } from "./app-settings";
import { keycloakIssuer } from "./oidc-app";

export interface AgentIdentity {
  username: string;
  email: string;
  password: pulumi.Output<string>;
}

export function createAgentIdentities() {
  const create = (name: string, username = `agent-${name}`): AgentIdentity => ({
    username,
    email: `${username}@gdario.dev`,
    password: pulumi.secret(new random.RandomPassword(`keycloak-agent-${name}-password`, {
      length: 48, special: false,
    }).result),
  });
  return {
    hermes: create("hermes"), codex: create("codex"), openclaw: create("openclaw"),
    codingBot: create("coding-bot", "coding-bot"),
    reviewingBot: create("reviewing-bot", "reviewing-bot"),
    renovate: create("renovate", "renovate"),
  };
}

export function agentIdentitySettings(identity: AgentIdentity): AppSettings {
  return {
    config: {
      AGENT_IDENTITY_ISSUER: keycloakIssuer,
      AGENT_IDENTITY_ACCOUNT_URL: `${keycloakIssuer}/account/`,
      AGENT_IDENTITY_INSTRUCTIONS: "Use Sign in with Keycloak in application UIs and the AGENT_IDENTITY_USERNAME and AGENT_IDENTITY_PASSWORD credentials. Create personal API tokens under your own application account for MCP/API access and store them in persistent credential storage. Never print credentials or tokens. Do not change your Keycloak password; it is managed by infrastructure.",
    },
    secrets: {
      AGENT_IDENTITY_USERNAME: identity.username,
      AGENT_IDENTITY_PASSWORD: identity.password,
    },
  };
}
