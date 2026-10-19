import * as pulumi from "@pulumi/pulumi";
import * as forgejo from "@pulumi/forgejo";
import { forgejoIdentity } from "../app/identity";

export interface CreateRepoArgs {
  name: string;
  organization?: string;
  isPublic?: boolean;
}

export function createRepositoryFactory(dependencies: pulumi.Resource[] = []) {
  const provider = new forgejo.Provider("forgejo", {
    host: forgejoIdentity.url,
    apiToken: new pulumi.Config("forgejo").requireSecret("apiToken"),
  }, { dependsOn: dependencies });
  const organizations = new Map<string, {
    name: pulumi.Output<string>;
    owners: pulumi.Output<string>;
    contributors: forgejo.Team;
  }>();

  function organizationTeams(organization: string) {
    const existing = organizations.get(organization);
    if (existing) return existing;

    // Looking up the native Owners team also rejects personal namespaces without
    // making this helper responsible for the organization's lifecycle.
    const owners = forgejo.getTeamOutput({ organization, name: "Owners" }, { provider });
    const name = owners.apply(team => {
      if (team.permission !== "owner" || !team.includesAllRepositories) {
        throw new Error(`${organization} must have its native Owners team with access to all repositories`);
      }
      return organization;
    });
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
    const result = { name, owners: owners.name, contributors };
    organizations.set(organization, result);
    return result;
  }

  return function createRepo({ name, organization = "home", isPublic = true }: CreateRepoArgs) {
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
      mergeWhitelistTeams: [teams.owners],
      mergeWhitelistUsernames: [],
      requiredApprovals: 1,
      enableApprovalsWhitelist: true,
      approvalsWhitelistTeams: [teams.owners],
      approvalsWhitelistUsernames: [],
      dismissStaleApprovals: true,
      enableStatusCheck: true,
      statusCheckContexts: ["cicd"],
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
