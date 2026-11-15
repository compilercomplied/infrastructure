import { OidcAppRegistration } from "../../library/oidc-app";
import { tandoorIdentity } from "../../workloads/selfhosted/tandoor-recipes/identity";
import { linkwardenIdentity } from "../../workloads/selfhosted/linkwarden/identity";
import { grafanaIdentity } from "../../workloads/monitoring/grafana/identity";
import { grimmoryIdentity } from "../../workloads/selfhosted/grimmory/identity";
import { hermesIdentity } from "../../workloads/agents/hermes-agent/identity";
import { forgejoIdentity } from "../../workloads/forgejo/app/identity";
import { memosIdentity } from "../../workloads/selfhosted/memos/identity";
import { windshiftIdentity } from "../../workloads/selfhosted/windshift/identity";
import { outlineIdentity } from "../../workloads/selfhosted/outline/identity";
import { excalidashIdentity } from "../../workloads/selfhosted/excalidash/identity";
import { doopIdentity } from "../../workloads/selfhosted/doop/identity";

import { pulpIdentity } from "../../workloads/selfhosted/pulp/identity";

export const oidcApps: readonly OidcAppRegistration[] = [
  tandoorIdentity,
  linkwardenIdentity,
  grafanaIdentity,
  grimmoryIdentity,
  hermesIdentity,
  forgejoIdentity,
  memosIdentity,
  windshiftIdentity,
  outlineIdentity,
  excalidashIdentity,
  doopIdentity,
  pulpIdentity,
];

export function validateOidcApps(): void {
  const keys = new Set<string>();
  const slugs = new Set<string>();
  const clientIds = new Set<string>();
  for (const app of oidcApps) {
    if (keys.has(app.key) || slugs.has(app.slug) || clientIds.has(app.clientId)) {
      throw new Error(`Duplicate OIDC registration: ${app.slug}`);
    }
    keys.add(app.key);
    slugs.add(app.slug);
    clientIds.add(app.clientId);
    if (!app.scopes.includes("openid") || new Set(app.scopes).size !== app.scopes.length) {
      throw new Error(`Invalid OIDC scopes: ${app.slug}`);
    }
    if (!app.callbackPath.startsWith("/") || new URL(app.callbackPath, app.url).origin !== new URL(app.url).origin) {
      throw new Error(`Invalid OIDC callback: ${app.slug}`);
    }
  }
}

validateOidcApps();
