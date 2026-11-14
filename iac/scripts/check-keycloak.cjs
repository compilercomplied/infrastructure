const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const yaml = require("js-yaml");
const pulumi = require("@pulumi/pulumi");
const k8s = require("@pulumi/kubernetes");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, filename);
};
const stack = yaml.load(fs.readFileSync(path.join(__dirname, "../Pulumi.local.yaml"), "utf8")).config;
const googleSubjects = { gdario: "100000000000000000001", Andrea: "100000000000000000002" };
pulumi.runtime.setAllConfig(Object.fromEntries(Object.entries(stack).map(([key, value]) => [
  key, key === "keycloakIdentity:googleSubjects" ? JSON.stringify(googleSubjects) :
    value?.secure ? "fixture-secret" : typeof value === "object" ? JSON.stringify(value) : String(value),
])));

async function main() {
  const resources = [];
  await pulumi.runtime.setMocks({
    newResource: args => {
      resources.push(args);
      return { id: `${args.name}-id`, state: {
        ...args.inputs,
        ...(args.type === "random:index/randomPassword:RandomPassword" ? { result: `${args.name}-fixture-secret` } : {}),
      } };
    }, call: args => args.inputs,
  }, "infrastructure", "test", false);
  const { configureKeycloak } = require("../platform/core/keycloak/index.ts");
  const { configureKeycloakIdentities } = require("../platform/core/keycloak/identities.ts");
  await pulumi.runtime.runInPulumiStack(async () => {
    const database = new k8s.core.v1.Service("database-fixture", {
      metadata: { namespace: "shared-resources" }, spec: { ports: [{ port: 5432 }] },
    });
    const keycloak = configureKeycloak("infrastructure", [database]);
    const identities = configureKeycloakIdentities(keycloak);
    await pulumi.all([
      keycloak.app.deployment.spec, keycloak.app.service.spec, keycloak.bootstrap.spec,
      ...keycloak.app.backupJobs.map(job => job.spec),
      ...keycloak.app.ingresses.map(ingress => ingress.metadata),
      ...keycloak.app.internalPolicies.map(policy => policy.spec),
      identities.googleCallback, identities.users.map(user => user.federatedIdentities),
      identities.clients.map(client => client.clientId),
      identities.resources.map(resource => resource.urn),
    ]).promise();
    assert.equal(await pulumi.isSecret(keycloak.automationSecret), true);
  });
  const unwrap = value => {
    if (pulumi.runtime.isRpcSecret(value)) return unwrap(pulumi.runtime.unwrapRpcSecret(value));
    if (Array.isArray(value)) return value.map(unwrap);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrap(v)]));
    return value;
  };
  const get = (type, name) => {
    const resource = resources.find(r => r.type === type && r.name === name);
    assert.ok(resource, `Missing ${name}`);
    return unwrap(resource.inputs);
  };
  const runtime = get("kubernetes:core/v1:Secret", "keycloak-secrets").stringData;
  assert.deepEqual(Object.keys(runtime).sort(), ["KC_BOOTSTRAP_ADMIN_CLIENT_SECRET", "KC_DB_PASSWORD"]);
  assert.ok(!Object.values(runtime).includes("keycloak-automation-secret-fixture-secret"));
  const config = get("kubernetes:core/v1:ConfigMap", "keycloak-config").data;
  assert.equal(config.KC_HOSTNAME, "https://keycloak.gdario.dev");
  assert.equal(config.KC_PROXY_HEADERS, "xforwarded");
  const server = get("kubernetes:apps/v1:Deployment", "keycloak").spec.template.spec;
  const bootstrap = get("kubernetes:batch/v1:Job", "keycloak-bootstrap").spec.template.spec;
  const dbInit = get("kubernetes:batch/v1:Job", "init-keycloak-db").spec.template.spec;
  for (const pod of [server, bootstrap, dbInit]) {
    assert.equal(pod.automountServiceAccountToken, false);
    assert.equal(pod.securityContext.seccompProfile.type, "RuntimeDefault");
    assert.equal(pod.containers[0].securityContext.allowPrivilegeEscalation, false);
  }
  assert.equal(server.securityContext.runAsNonRoot, true);
  assert.equal(bootstrap.containers[0].securityContext.readOnlyRootFilesystem, true);
  const service = get("kubernetes:core/v1:Service", "keycloak");
  assert.deepEqual(service.spec.ports.map(p => p.targetPort), [8080]);
  const ingress = get("kubernetes:networking.k8s.io/v1:Ingress", "keycloak-ingress");
  assert.equal(ingress.metadata.annotations["traefik.ingress.kubernetes.io/router.entrypoints"], "tailnet");
  assert.equal(ingress.spec.rules[0].host, "keycloak.gdario.dev");
  const policy = get("kubernetes:networking.k8s.io/v1:NetworkPolicy", "keycloak-allow-keycloak-bootstrap");
  assert.deepEqual(policy.spec.ingress[0].from, [{ podSelector: { matchLabels: { app: "keycloak-bootstrap" } } }]);
  assert.equal(policy.spec.ingress[0].ports[0].port, 8080);
  assert.ok(resources.some(r => r.type === "kubernetes:batch/v1:CronJob" && r.name.includes("keycloak")));
  const realm = get("keycloak:index/realm:Realm", "homelab-identity-realm");
  assert.equal(realm.registrationAllowed, false);
  assert.equal(realm.duplicateEmailsAllowed, false);
  const google = get("keycloak:oidc/googleIdentityProvider:GoogleIdentityProvider", "homelab-google");
  assert.equal(google.alias, "google");
  assert.equal(google.clientId, stack["keycloakIdentity:googleClientId"]);
  assert.notEqual(google.clientId, stack["selfhosted:googleClientId"]);
  assert.equal(google.syncMode, "FORCE");
  assert.equal(google.storeToken, false);
  assert.equal(google.firstBrokerLoginFlowAlias, "prelinked-identities-only");
  const deny = get("keycloak:authentication/execution:Execution", "homelab-deny-enrollment");
  assert.equal(deny.authenticator, "deny-access-authenticator");
  assert.equal(deny.requirement, "REQUIRED");
  for (const [name, subject] of Object.entries(googleSubjects)) {
    const user = get("keycloak:index/user:User", `homelab-user-${name.toLowerCase()}`);
    assert.equal(user.federatedIdentities[0].identityProvider, "google");
    assert.equal(user.federatedIdentities[0].userId, subject);
    assert.equal(user.emailVerified, false);
    assert.equal(user.initialPassword, undefined);
  }
  const adminGroups = get("keycloak:index/userGroups:UserGroups", "homelab-user-gdario-groups");
  const memberGroups = get("keycloak:index/userGroups:UserGroups", "homelab-user-andrea-groups");
  assert.equal(adminGroups.groupIds.length, 3);
  assert.deepEqual(memberGroups.groupIds, ["homelab-hermes-users-id"]);
  const mapping = get("keycloak:openid/groupMembershipProtocolMapper:GroupMembershipProtocolMapper", "homelab-groups-claim");
  assert.equal(mapping.fullPath, false);
  assert.equal(mapping.claimName, "groups");
  assert.ok(mapping.addToIdToken && mapping.addToUserinfo && mapping.addToAccessToken);
  const { oidcApps } = require("../platform/core/oidc-apps.ts");
  for (const app of oidcApps) {
    const client = get("keycloak:openid/client:Client", `homelab-oidc-${app.key}`);
    assert.equal(client.clientId, app.clientId);
    assert.deepEqual(client.validRedirectUris, [app.url + app.callbackPath]);
    assert.equal(client.serviceAccountsEnabled, false);
    assert.equal(client.directAccessGrantsEnabled, false);
    assert.equal(client.implicitFlowEnabled, false);
    assert.equal(client.fullScopeAllowed, false);
    const scopes = get("keycloak:openid/clientOptionalScopes:ClientOptionalScopes", `homelab-oidc-${app.key}-optional-scopes`);
    assert.deepEqual(scopes.optionalScopes, app.scopes.includes("offline_access") ? ["offline_access"] : []);
  }
  console.log("Validated Keycloak hosting, pre-linked Google subjects, denied enrollment, group privileges, and staged OIDC clients.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
