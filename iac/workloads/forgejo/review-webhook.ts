import * as pulumi from "@pulumi/pulumi";
import { forgejoIdentity } from "./app/identity";

interface HookInputs {
  host: string;
  organization: string;
  destination: string;
  apiToken: string;
  secret: string;
  events: string[];
  active: boolean;
  type: string;
  contentType: string;
}
interface Hook {
  id: number;
  active: boolean;
  type: string;
  config: Record<string, string>;
  events: string[];
  branch_filter: string;
  authorization_header: string;
}

function normalizedEvents(events: string[]): string[] {
  const expanded = new Set(events);
  // Forgejo expands these API groups when returning a hook's event array.
  if (expanded.has("pull_request")) {
    for (const event of ["pull_request_assign", "pull_request_label", "pull_request_milestone",
      "pull_request_comment", "pull_request_sync", "pull_request_review_request", "pull_request_review"]) expanded.add(event);
  }
  if (expanded.delete("pull_request_review")) {
    for (const event of ["pull_request_review_approved", "pull_request_review_rejected", "pull_request_review_comment"]) expanded.add(event);
  }
  return [...expanded].sort();
}

// svalabs/forgejo 1.7.0 only exposes repository_webhook (repository_id is required).
// Adoption must never recreate the live organization hook or change its HMAC secret.
class OrganizationWebhookProvider implements pulumi.dynamic.ResourceProvider {
  private async call(inputs: HookInputs, method: "GET" | "PATCH", suffix: string, body?: unknown): Promise<Hook | Hook[]> {
    if (inputs.host !== "https://git.gdario.dev" || inputs.organization !== "home" ||
        inputs.destination !== "http://orchestrator-api.agent-dev-environment.svc.cluster.local/webhooks/forgejo" ||
        inputs.secret.length < 32) {
      throw new Error("Invalid managed review webhook boundary");
    }
    const response = await fetch(`${inputs.host}/api/v1/orgs/${inputs.organization}/hooks${suffix}`, {
      method, redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `token ${inputs.apiToken}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) throw new Error(`Forgejo organization hook ${method}: HTTP ${response.status}`);
    return await response.json() as Hook | Hook[];
  }
  private async discover(inputs: HookInputs, id = "home/1"): Promise<Hook> {
    if (id !== "home/1") throw new Error("Unexpected managed hook ID; refusing identity substitution");
    const matches: Hook[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await this.call(inputs, "GET", `?limit=50&page=${page}`);
      if (!Array.isArray(batch)) throw new Error("Organization webhook listing unavailable");
      matches.push(...batch.filter(hook => hook.config.url === inputs.destination));
      if (batch.length < 50) break;
      if (page === 100) throw new Error("Organization hook pagination bound exceeded");
    }
    if (matches.length !== 1 || matches[0].id !== 1) {
      throw new Error("Expected exactly the existing home/1 review hook; refusing missing, duplicate or substituted adoption");
    }
    const hook = await this.call(inputs, "GET", "/1") as Hook;
    if (hook.id !== 1 || hook.config.url !== inputs.destination || hook.type !== inputs.type) {
      throw new Error("Managed hook identity changed; refusing disruptive replacement");
    }
    return hook;
  }
  private matches(hook: Hook, inputs: HookInputs): boolean {
    return hook.active === inputs.active && hook.type === inputs.type && hook.config.url === inputs.destination &&
      hook.config.content_type === inputs.contentType &&
      JSON.stringify(normalizedEvents(hook.events)) === JSON.stringify(normalizedEvents(inputs.events));
  }
  private validateDesired(inputs: HookInputs): void {
    if (!inputs.active || inputs.type !== "forgejo" || inputs.contentType !== "json") {
      throw new Error("Invalid desired review webhook configuration");
    }
  }
  async create(inputs: HookInputs): Promise<pulumi.dynamic.CreateResult> {
    this.validateDesired(inputs);
    const hook = await this.discover(inputs);
    if (!this.matches(hook, inputs)) throw new Error("Existing home/1 configuration differs; initial adoption must be read-only");
    return { id: "home/1", outs: { ...inputs, hookId: hook.id } };
  }
  async read(id: string, props: HookInputs): Promise<pulumi.dynamic.ReadResult> {
    // Missing hooks fail closed instead of telling Pulumi to create a replacement.
    const hook = await this.discover(props, id);
    // The API does not return the HMAC secret; retain its encrypted desired input.
    return { id, props: { ...props, destination: hook.config.url, events: hook.events,
      active: hook.active, type: hook.type, contentType: hook.config.content_type, hookId: hook.id } };
  }
  async diff(_id: string, olds: HookInputs, news: HookInputs): Promise<pulumi.dynamic.DiffResult> {
    return { changes: olds.active !== news.active || olds.type !== news.type || olds.contentType !== news.contentType ||
      JSON.stringify(normalizedEvents(olds.events)) !== JSON.stringify(normalizedEvents(news.events)) ||
      olds.host !== news.host || olds.organization !== news.organization || olds.destination !== news.destination ||
      olds.apiToken !== news.apiToken || olds.secret !== news.secret };
  }
  async update(id: string, olds: HookInputs, news: HookInputs): Promise<pulumi.dynamic.UpdateResult> {
    this.validateDesired(news);
    // Forgejo 16.0.5's editHook does not update Secret. Never claim a rotation succeeded.
    if (olds.secret !== news.secret) throw new Error("Forgejo cannot rotate an organization hook secret through PATCH; preserve the existing hook and coordinate a supported owner-side rotation first");
    const hook = await this.discover(news, id);
    if (this.matches(hook, news)) return { outs: { ...news, hookId: hook.id } };
    // editHook also leaves Actions flags untouched and overwrites filters/authorization.
    const actions = (events: string[]) => normalizedEvents(events).filter(event => event.startsWith("action_run_"));
    if (JSON.stringify(actions(hook.events)) !== JSON.stringify(actions(news.events)) ||
        typeof hook.branch_filter !== "string" || hook.authorization_header !== "") {
      throw new Error("Unsupported hook Actions, filter or authorization state; refusing a partial reconciliation");
    }
    await this.call(news, "PATCH", "/1", {
      active: news.active, events: news.events, branch_filter: hook.branch_filter, authorization_header: "",
      config: { url: news.destination, content_type: news.contentType },
    });
    const written = await this.discover(news, id);
    if (!this.matches(written, news) || written.branch_filter !== hook.branch_filter || written.authorization_header !== "") {
      throw new Error("Managed organization webhook readback mismatch");
    }
    return { outs: { ...news, hookId: written.id } };
  }
  // Retiring IaC ownership must not silently interrupt an existing organization hook.
  async delete(): Promise<void> { /* Explicit operator retirement is required. */ }
}

class OrganizationReviewWebhook extends pulumi.dynamic.Resource {
  readonly hookId!: pulumi.Output<number>;
  constructor(name: string, inputs: pulumi.Inputs, options: pulumi.CustomResourceOptions) {
    super(new OrganizationWebhookProvider(), name, { ...inputs, hookId: undefined }, {
      ...options, protect: true, retainOnDelete: true, additionalSecretOutputs: ["apiToken", "secret"],
    });
  }
}

export function configureReviewWebhook(apiToken: pulumi.Input<string>, dependencies: pulumi.Resource[]) {
  // This output includes the canonical explicit-secret-or-HMAC fallback from the reviewer stack.
  const reviewer = new pulumi.StackReference("forgejo-reviewer-stack", { name: "gdariodev/agent-dev-environment/prod" });
  return new OrganizationReviewWebhook("forgejo-home-review-webhook", {
    host: forgejoIdentity.url, organization: "home",
    destination: "http://orchestrator-api.agent-dev-environment.svc.cluster.local/webhooks/forgejo",
    apiToken, secret: pulumi.secret(reviewer.requireOutput("reviewWebhookSecret")),
    active: true, type: "forgejo", contentType: "json",
    events: ["pull_request_comment", "pull_request", "pull_request_sync", "pull_request_review",
      "push", "action_run_success", "action_run_failure", "action_run_recover"],
  }, { dependsOn: dependencies });
}
