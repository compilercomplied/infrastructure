import * as pulumi from "@pulumi/pulumi";
import * as forgejo from "@pulumi/forgejo";

import { ManagedForgejoUsers } from "../users";

export interface CreateRepoArgs {
  name: string;
  organization?: string;
  isPublic?: boolean;
  requiredStatusChecks?: string[];
}

export function createRepositoryFactory(host: pulumi.Input<string>, users: ManagedForgejoUsers, dependencies: pulumi.Resource[] = []) {
  const provider = new forgejo.Provider("forgejo", {
    host,
    apiToken: new pulumi.Config("forgejo").requireSecret("apiToken"),
  }, { dependsOn: dependencies });
  const organizations = new Map<string, {
    name: pulumi.Output<string>;
    owners: pulumi.Output<string>;
    contributors: forgejo.Team;
    reviewers: forgejo.Team;
  }>();

  function organizationTeams(organization: string) {
    const existing = organizations.get(organization);
    if (existing) return existing;

    // Forgejo creates Owners with the organization; retaining it protects native ownership.
    const owners = new forgejo.Team(`forgejo-${organization}-owners`, {
      organization, name: "Owners", permission: "owner",
      includesAllRepositories: true, canCreateOrgRepo: true,
      unitsMap: Object.fromEntries([
        "repo.actions", "repo.code", "repo.ext_issues", "repo.ext_wiki", "repo.issues",
        "repo.packages", "repo.projects", "repo.pulls", "repo.releases", "repo.wiki",
      ].map(unit => [unit, "owner"])),
    }, { provider, protect: true, retainOnDelete: true });
    const name = pulumi.output(organization);
    const contributors = new forgejo.Team(`forgejo-${organization}-contributors`, {
      organization: name,
      name: "Contributors",
      permission: "read",
      includesAllRepositories: true,
      canCreateOrgRepo: false,
      unitsMap: {
        "repo.actions": "read",
        "repo.code": "write",
        "repo.issues": "write",
        "repo.packages": "write",
        "repo.projects": "write",
        "repo.pulls": "write",
        "repo.releases": "write",
        "repo.wiki": "write",
      },
    }, {
      provider,
      protect: true,
      ignoreChanges: ["description"],
    });
    if (organization === "home") {
      for (const [login, user] of Object.entries({
        "coding-bot": users.codingBot, "reviewing-bot": users.reviewingBot,
        "agent-codex": users.codex, "agent-hermes": users.hermes, "agent-openclaw": users.openclaw,
      })) {
        new forgejo.TeamMember(`forgejo-${organization}-contributor-${login}`, {
          teamId: contributors.teamId,
          user: user.login,
        }, { provider });
      }
    }
    const reviewers = new forgejo.Team(`forgejo-${organization}-reviewers`, {
      organization: name,
      name: "Reviewers",
      permission: "read",
      includesAllRepositories: true,
      canCreateOrgRepo: false,
      unitsMap: {
        "repo.actions": "read",
        "repo.code": "read",
        "repo.issues": "write",
        "repo.pulls": "write",
      },
    }, { provider, protect: true });
    new forgejo.TeamMember(`forgejo-${organization}-reviewing-bot`, {
      teamId: reviewers.teamId,
      user: users.reviewingBot.login,
    }, { provider });
    new forgejo.TeamMember(`forgejo-${organization}-owner-dario`, {
      teamId: owners.teamId, user: users.dario.login,
    }, { provider, protect: true });
    const result = { name, owners: owners.name, contributors, reviewers };
    organizations.set(organization, result);
    return result;
  }

  return function createRepo({
    name,
    organization = "home",
    isPublic = true,
    requiredStatusChecks = ["cicd / cicd (pull_request)"],
  }: CreateRepoArgs) {
    const teams = organizationTeams(organization);
    const identity = `${organization}/${name}`;
    const repo = new forgejo.Repository(`forgejo-${identity}`, {
      owner: teams.name,
      name,
      private: !isPublic,
      autoInit: true,
      defaultBranch: "master",
      allowMergeCommits: false,
      allowRebase: false,
      allowRebaseExplicit: false,
      allowFastForwardOnlyMerge: false,
      allowSquashMerge: true,
      allowManualMerge: false,
      autodetectManualMerge: false,
      defaultMergeStyle: "squash",
      defaultDeleteBranchAfterMerge: false,
      allowRebaseUpdate: true,
      defaultAllowMaintainerEdit: false,
      defaultUpdateStyle: "merge",
      ignoreWhitespaceConflicts: false,
      hasIssues: true,
      hasPullRequests: true,
      hasActions: true,
      hasWiki: false,
      hasProjects: false,
      hasReleases: true,
      hasPackages: true,
      internalTracker: {
        enableTimeTracker: true,
        allowOnlyContributorsToTrackTime: true,
        enableIssueDependencies: true,
      },
    }, {
      provider,
      protect: true,
      // Git history must survive provider replacement or removal from Pulumi state.
      retainOnDelete: true,
      dependsOn: [teams.contributors],
      // Repository descriptions and templates remain editable outside this policy surface.
      ignoreChanges: ["description", "website", "template"],
    });

    const protection = new forgejo.BranchProtection(`forgejo-${identity}/master`, {
      repositoryId: repo.repositoryId,
      branchName: "master",
      enablePush: true,
      enablePushWhitelist: true,
      pushWhitelistTeams: [teams.owners],
      pushWhitelistUsernames: [],
      pushWhitelistDeployKeys: false,
      enableMergeWhitelist: true,
      mergeWhitelistTeams: [teams.owners, teams.contributors.name],
      mergeWhitelistUsernames: [],
      requiredApprovals: 1,
      enableApprovalsWhitelist: true,
      approvalsWhitelistTeams: [teams.owners, teams.reviewers.name],
      approvalsWhitelistUsernames: [],
      dismissStaleApprovals: true,
      enableStatusCheck: requiredStatusChecks.length > 0,
      statusCheckContexts: requiredStatusChecks,
      blockOnRejectedReviews: true,
      blockOnOfficialReviewRequests: true,
      blockOnOutdatedBranch: true,
      requireSignedCommits: false,
      protectedFilePatterns: "",
      unprotectedFilePatterns: "",
    }, {
      provider,
      protect: true,
    });
    return { repo, protection };
  };
}
