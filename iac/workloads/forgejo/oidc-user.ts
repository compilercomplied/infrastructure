import * as pulumi from "@pulumi/pulumi";

export interface OidcUserInputs {
  host: string;
  adminToken: string;
  login: string;
  sourceId: number;
  loginName: string;
  email: string;
  fullName: string;
  active: boolean;
  admin: boolean;
  allowCreateOrganization: boolean;
  allowGitHook: boolean;
  allowImportLocal: boolean;
  maxRepoCreation: number;
  mustChangePassword: boolean;
  prohibitLogin: boolean;
  restricted: boolean;
  visibility: string;
}

// The bridged user resource requires a local password even for external accounts.
// Forgejo's admin API can provision OIDC bindings without setting a password.
export class OidcUserProvider implements pulumi.dynamic.ResourceProvider {
  private async request(inputs: OidcUserInputs, method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${inputs.host}/api/v1/${path}`, {
      method,
      headers: { Authorization: `token ${inputs.adminToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 404 && method === "GET") return undefined;
    if (!response.ok) throw new Error(`Forgejo OIDC user API ${method} failed: HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }

  private settings(inputs: OidcUserInputs) {
    return {
      source_id: inputs.sourceId, login_name: inputs.loginName,
      email: inputs.email, full_name: inputs.fullName,
      active: inputs.active, admin: inputs.admin,
      allow_create_organization: inputs.allowCreateOrganization,
      allow_git_hook: inputs.allowGitHook, allow_import_local: inputs.allowImportLocal,
      max_repo_creation: inputs.maxRepoCreation, must_change_password: inputs.mustChangePassword,
      prohibit_login: inputs.prohibitLogin, restricted: inputs.restricted, visibility: inputs.visibility,
    };
  }

  async check(_olds: OidcUserInputs, news: OidcUserInputs): Promise<pulumi.dynamic.CheckResult> {
    const failures = [];
    if (!Number.isInteger(news.sourceId) || news.sourceId <= 0) {
      failures.push({ property: "sourceId", reason: "An external authentication source is required" });
    }
    if (!news.loginName) failures.push({ property: "loginName", reason: "A Keycloak subject is required" });
    return { inputs: news, failures };
  }

  async create(inputs: OidcUserInputs): Promise<pulumi.dynamic.CreateResult> {
    const user = await this.request(inputs, "POST", "admin/users", {
      username: inputs.login, ...this.settings(inputs), send_notify: false,
    });
    if (!user?.id) throw new Error("Forgejo user creation did not return an ID");
    await this.request(inputs, "PATCH", `admin/users/${encodeURIComponent(inputs.login)}`, this.settings(inputs));
    return { id: String(user.id), outs: inputs };
  }

  async read(id: string, props: OidcUserInputs): Promise<pulumi.dynamic.ReadResult> {
    const user = await this.request(props, "GET", `users/${encodeURIComponent(props.login)}`);
    if (!user || String(user.id) !== id) return { id: undefined, props };
    return {
      id,
      props: {
        ...props, login: user.login, sourceId: user.source_id, loginName: user.login_name,
        email: user.email, fullName: user.full_name, active: user.active, admin: user.is_admin,
        prohibitLogin: user.prohibit_login, restricted: user.restricted, visibility: user.visibility,
      },
    };
  }

  async diff(_id: string, olds: OidcUserInputs, news: OidcUserInputs): Promise<pulumi.dynamic.DiffResult> {
    const replaces = (["host", "login"] as const).filter(key => olds[key] !== news[key]);
    const changes = (Object.keys(news) as (keyof OidcUserInputs)[])
      .some(key => String(key) !== "__provider" && olds[key] !== news[key]);
    return { changes, replaces };
  }

  async update(_id: string, _olds: OidcUserInputs, news: OidcUserInputs): Promise<pulumi.dynamic.UpdateResult> {
    await this.request(news, "PATCH", `admin/users/${encodeURIComponent(news.login)}`, this.settings(news));
    return { outs: news };
  }

  async delete(_id: string, props: OidcUserInputs): Promise<void> {
    await this.request(props, "DELETE", `admin/users/${encodeURIComponent(props.login)}`);
  }
}

export class ForgejoOidcUser extends pulumi.dynamic.Resource {
  public readonly login!: pulumi.Output<string>;

  constructor(name: string, args: { [K in keyof OidcUserInputs]: pulumi.Input<OidcUserInputs[K]> }, opts?: pulumi.CustomResourceOptions) {
    super(new OidcUserProvider(), name, args, {
      ...opts, protect: true, retainOnDelete: true, additionalSecretOutputs: ["adminToken"],
    }, "forgejo", "OidcUser");
  }
}
