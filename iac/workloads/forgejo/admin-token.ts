import * as pulumi from "@pulumi/pulumi";

interface AdminTokenInputs {
  host: string;
  adminToken: string;
  user: string;
  name: string;
  scopes: string[];
}

// Forgejo's user-token API requires password Basic authentication, which is disabled here.
// Its admin API supports token-authenticated provisioning without changing that policy.
class AdminTokenProvider implements pulumi.dynamic.ResourceProvider {
  private async request(inputs: AdminTokenInputs, method: string, suffix = "", body?: unknown): Promise<any> {
    const url = `${inputs.host}/api/v1/admin/users/${encodeURIComponent(inputs.user)}/tokens${suffix}`;
    const response = await fetch(url, {
      method,
      headers: { Authorization: `token ${inputs.adminToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Forgejo admin token API ${method} failed: HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }

  private async list(inputs: AdminTokenInputs): Promise<any[]> {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const tokens = await this.request(inputs, "GET", `?limit=50&page=${page}`);
      if (!Array.isArray(tokens)) throw new Error("Forgejo token list returned an unexpected response");
      result.push(...tokens);
      if (tokens.length < 50) return result;
    }
    throw new Error("Forgejo token listing exceeded its pagination limit");
  }

  async create(inputs: AdminTokenInputs): Promise<pulumi.dynamic.CreateResult> {
    const existing = await this.list(inputs);
    if (existing.some((token: { name: string }) => token.name === inputs.name)) {
      throw new Error("A token with this name already exists; its secret cannot be recovered automatically");
    }
    const token = await this.request(inputs, "POST", "", { name: inputs.name, scopes: inputs.scopes });
    if (!token?.id || !token?.sha1) throw new Error("Forgejo token creation did not return an ID and secret");
    return { id: String(token.id), outs: { ...inputs, token: token.sha1 } };
  }

  async read(id: string, props: AdminTokenInputs & { token: string }): Promise<pulumi.dynamic.ReadResult> {
    const existing = await this.list(props);
    return existing.some((token: { id: number }) => String(token.id) === id)
      ? { id, props }
      : { id: undefined, props };
  }

  async diff(_id: string, old: AdminTokenInputs, news: AdminTokenInputs): Promise<pulumi.dynamic.DiffResult> {
    const replaces = (["host", "user", "name", "scopes"] as const).filter(key => JSON.stringify(old[key]) !== JSON.stringify(news[key]));
    return { changes: replaces.length > 0 || old.adminToken !== news.adminToken, replaces };
  }

  async update(_id: string, olds: AdminTokenInputs & { token: string }, news: AdminTokenInputs): Promise<pulumi.dynamic.UpdateResult> {
    return { outs: { ...news, token: olds.token } };
  }

  async delete(id: string, props: AdminTokenInputs): Promise<void> {
    await this.request(props, "DELETE", `/${encodeURIComponent(id)}`);
  }
}

export class ForgejoAdminToken extends pulumi.dynamic.Resource {
  public readonly token!: pulumi.Output<string>;

  constructor(name: string, args: { [K in keyof AdminTokenInputs]: pulumi.Input<AdminTokenInputs[K]> }, opts?: pulumi.CustomResourceOptions) {
    super(new AdminTokenProvider(), name, { ...args, token: undefined }, {
      ...opts,
      additionalSecretOutputs: ["token"],
    });
  }
}
