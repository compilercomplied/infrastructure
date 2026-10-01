const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const yaml = require("js-yaml");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  module._compile(compiled.outputText, filename);
};

const { oidcApps, validateOidcApps } = require("../platform/core/oidc-apps.ts");
const { renderAuthentikBlueprint } = require("../platform/core/oidc-blueprint.ts");
const template = fs.readFileSync(path.join(__dirname, "../platform/core/templates/authentik-blueprints.yaml"), "utf8");
const marker = "  # OIDC_APP_REGISTRATIONS";
if (template.split(marker).length !== 2) throw new Error("Expected exactly one OIDC blueprint marker");

validateOidcApps();
const rendered = renderAuthentikBlueprint(template);
const tag = (name, kind) => new yaml.Type(name, { kind, construct: value => value });
const schema = yaml.DEFAULT_SCHEMA.extend([
  tag("!Env", "scalar"),
  tag("!KeyOf", "scalar"),
  tag("!Find", "sequence"),
]);
const blueprint = yaml.load(rendered, { schema });
const providers = blueprint.entries.filter(entry => entry.model === "authentik_providers_oauth2.oauth2provider");
const applications = blueprint.entries.filter(entry => entry.model === "authentik_core.application");
const customEmailMapping = blueprint.entries.find(entry => entry.id === "windshift-email-scope");
if (oidcApps.some(app => app.verifiedLocalEmail) && !customEmailMapping) {
  throw new Error("Missing verified email scope mapping");
}

for (const app of oidcApps) {
  const provider = providers.find(entry => entry.attrs.client_id === app.clientId);
  const application = applications.find(entry => entry.identifiers.slug === app.slug);
  if (!provider || !application) throw new Error(`Missing OIDC resources for ${app.slug}`);
  if (provider.attrs.client_secret !== app.secretEnv) throw new Error(`Secret reference drift for ${app.slug}`);
  if (provider.attrs.redirect_uris[0].url !== app.url + app.callbackPath) throw new Error(`Callback drift for ${app.slug}`);
  if (application.attrs.provider !== `${app.key}-provider`) throw new Error(`Provider reference drift for ${app.slug}`);
}

if (providers.length !== oidcApps.length) throw new Error("Unexpected OIDC provider in blueprint");
process.stdout.write(`Validated ${providers.length} OIDC registrations and blueprint YAML.\n`);
