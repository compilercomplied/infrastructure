// Importing preserves the IDs, history and memberships of pre-existing resources.
// These are migration records, not additional options for createRepo callers.
export const existingContributorTeams = new Set(["home"]);

export const existingRepositories: Record<string, readonly string[] | undefined> = {
  "home/homelab-iac": ["master"],
  "home/game-launcher": ["master"],
  "home/repo-template": ["master"],
  "home/tandoor-mcp": [],
  "home/agent-dev-environment": ["master", "main", "trunk"],
};
