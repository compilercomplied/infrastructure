import { oidcApps } from "./oidc-apps";

const authorizationFlow = "!Find [authentik_flows.flow, [pk, 9faae557-fad6-4f95-876c-545adc95b3e4]]";
const invalidationFlow = "!Find [authentik_flows.flow, [pk, 12830a53-f573-488d-bdc2-f12ddc59c0a7]]";
const signingKey = "!Find [authentik_crypto.certificatekeypair, [pk, e96bc021-31ba-451e-b3ae-a7c62b7f1363]]";

function scopeMapping(scope: string): string {
  return `!Find [authentik_providers_oauth2.scopemapping, [managed, goauthentik.io/providers/oauth2/scope-${scope}]]`;
}

export function renderOidcBlueprint(): string {
  return oidcApps.map(app => {
    const providerId = `${app.key}-provider`;
    const mappings = app.scopes.map(scope => `        - ${app.verifiedLocalEmail && scope === "email" ? "!KeyOf windshift-email-scope" : scopeMapping(scope)}`).join("\n");
    const hasRefreshToken = app.scopes.some(scope => scope === "offline_access");
    const refresh = hasRefreshToken ? `\n        - refresh_token` : "";
    const refreshValidity = hasRefreshToken ? `\n      refresh_token_validity: days=30` : "";

    return `  - model: authentik_providers_oauth2.oauth2provider
    id: ${providerId}
    identifiers:
      name: ${app.providerName ?? `${app.name} SSO`}
    attrs:
      client_id: ${app.clientId}
      client_secret: !Env ${app.secretEnv}
      client_type: confidential
      authorization_flow: ${authorizationFlow}
      invalidation_flow: ${invalidationFlow}
      signing_key: ${signingKey}
      redirect_uris:
        - matching_mode: strict
          url: ${app.url}${app.callbackPath}
      property_mappings:
${mappings}
      grant_types:
        - authorization_code${refresh}
      access_token_validity: hours=1${refreshValidity}

  - model: authentik_core.application
    identifiers:
      slug: ${app.slug}
    attrs:
      name: ${app.name}
      provider: !KeyOf ${providerId}
      meta_launch_url: ${app.url}
      meta_publisher: GDario Labs`;
  }).join("\n\n") + "\n";
}

export function renderAuthentikBlueprint(template: string): string {
  return template.replace("  # OIDC_APP_REGISTRATIONS", renderOidcBlueprint().trimEnd());
}
