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
pulumi.runtime.setAllConfig(Object.fromEntries(Object.entries(stack).map(([key, value]) => [
  key, value?.secure ? "fixture-secret" : typeof value === "object" ? JSON.stringify(value) : String(value),
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
  await pulumi.runtime.runInPulumiStack(async () => {
    const database = new k8s.core.v1.Service("database-fixture", {
      metadata: { namespace: "shared-resources" }, spec: { ports: [{ port: 5432 }] },
    });
    const keycloak = configureKeycloak("infrastructure", [database]);
    await pulumi.all([
      keycloak.app.deployment.spec, keycloak.app.service.spec, keycloak.bootstrap.spec,
      ...keycloak.app.backupJobs.map(job => job.spec),
      ...keycloak.app.ingresses.map(ingress => ingress.metadata),
      ...keycloak.app.internalPolicies.map(policy => policy.spec),
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
  console.log("Validated private Keycloak exposure, credential isolation, database backup, and token-free bootstrap workloads.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
