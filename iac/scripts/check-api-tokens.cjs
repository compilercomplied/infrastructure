const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const yaml = require("js-yaml");
const pulumi = require("@pulumi/pulumi");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, filename);
};

// Mock credentials ensure the resource builders cannot contact production APIs.
const config = yaml.load(fs.readFileSync(path.join(__dirname, "../Pulumi.local.yaml"), "utf8")).config;
pulumi.runtime.setAllConfig(Object.fromEntries(Object.entries(config).map(([key, value]) => [
  key, value?.secure ? "fixture-secret" : typeof value === "object" ? JSON.stringify(value) : String(value),
])));

async function main() {
  const resources = [];
  const podSpecs = new Map();
  await pulumi.runtime.setMocks({
    newResource: args => {
      resources.push(args);
      return { id: `${args.name}-id`, state: args.inputs };
    },
    call: args => args.inputs,
  }, "infrastructure", "test", false);

  const { SelfhostedApp } = require("../library/selfhosted-component.ts");
  const { configureHermesAgent } = require("../workloads/agents/hermes-agent/index.ts");
  await pulumi.runtime.runInPulumiStack(async () => {
    const args = { namespace: "test", image: "fixture:1", endpoints: [{ name: "http", containerPort: 8080 }] };
    const ordinary = new SelfhostedApp("ordinary", args);
    const apiClient = new SelfhostedApp("api-client", { ...args, automountServiceAccountToken: true });
    const hermes = configureHermesAgent("agent-sidekicks");
    await Promise.all([["ordinary", ordinary], ["api-client", apiClient], ["hermes-agent", hermes]].map(async ([name, app]) => {
      podSpecs.set(name, (await app.deployment.spec.promise()).template.spec);
    }));
  });

  const deployment = name => podSpecs.get(name);
  assert.equal(deployment("ordinary").automountServiceAccountToken, false);
  assert.equal(deployment("api-client").automountServiceAccountToken, true);
  const hermes = deployment("hermes-agent");
  assert.equal(hermes.automountServiceAccountToken, false);
  assert.ok(!hermes.volumes.some(v => v.projected?.sources?.some(source => source.serviceAccountToken)));
  assert.ok(!hermes.containers.some(c => c.volumeMounts?.some(v => v.mountPath === "/var/run/secrets/kubernetes.io/serviceaccount")));
  assert.equal(resources.filter(r => r.type === "kubernetes:rbac.authorization.k8s.io/v1:ClusterRoleBinding").length, 0);
  assert.equal(resources.find(r => r.type === "kubernetes:core/v1:ServiceAccount").inputs.automountServiceAccountToken, false);
  console.log("Validated token-free app defaults, explicit API opt-in, and Hermes without projected credentials or an administrator binding.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
