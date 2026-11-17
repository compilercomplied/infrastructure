import { OidcAppRegistration } from "../../library/oidc-app";
import { anchorIdentity } from "../../workloads/selfhosted/anchor/identity";
import { tandoorIdentity } from "../../workloads/selfhosted/tandoor-recipes/identity";
import { linkwardenIdentity } from "../../workloads/selfhosted/linkwarden/identity";
import { grafanaIdentity } from "../../workloads/monitoring/grafana/identity";
import { grimmoryIdentity } from "../../workloads/selfhosted/grimmory/identity";
import { hermesIdentity } from "../../workloads/agents/hermes-agent/identity";
import { forgejoIdentity } from "../../workloads/forgejo/app/identity";
import { windshiftIdentity } from "../../workloads/selfhosted/windshift/identity";
import { outlineIdentity } from "../../workloads/selfhosted/outline/identity";
import { excalidashIdentity } from "../../workloads/selfhosted/excalidash/identity";
import { doopIdentity } from "../../workloads/selfhosted/doop/identity";

import { pulpIdentity } from "../../workloads/selfhosted/pulp/identity";

export const oidcApps: readonly OidcAppRegistration[] = [
  anchorIdentity,
  tandoorIdentity,
  linkwardenIdentity,
  grafanaIdentity,
  grimmoryIdentity,
  hermesIdentity,
  forgejoIdentity,
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
    if (app.publicClient ? app.secretKey !== undefined || app.generateSecret : !app.secretKey) {
      throw new Error(`Invalid OIDC client authentication: ${app.slug}`);
    }
    const nativeRedirects = app.nativeRedirectUris ?? [];
    if ((nativeRedirects.length > 0 && !app.publicClient) || new Set(nativeRedirects).size !== nativeRedirects.length) {
      throw new Error(`Invalid native OIDC redirects: ${app.slug}`);
    }
    for (const uri of nativeRedirects) {
      if (!/^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+\/[a-zA-Z0-9/_-]+$/.test(uri) ||
          ["http:", "https:", "file:", "javascript:", "data:"].includes(new URL(uri).protocol)) {
        throw new Error(`Invalid native OIDC redirect: ${app.slug}`);
      }
    }
    if (!app.scopes.includes("openid") || new Set(app.scopes).size !== app.scopes.length) {
      throw new Error(`Invalid OIDC scopes: ${app.slug}`);
    }
    for (const path of [app.callbackPath, app.postLogoutRedirectPath].filter((value): value is string => value !== undefined)) {
      if (!path.startsWith("/") || new URL(path, app.url).origin !== new URL(app.url).origin) {
        throw new Error(`Invalid OIDC callback: ${app.slug}`);
      }
    }
  }
}

validateOidcApps();
