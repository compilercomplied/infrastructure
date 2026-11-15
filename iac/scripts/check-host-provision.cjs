const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const pulumi = require("@pulumi/pulumi");
const yaml = require("js-yaml");
const { unwrapSecretValues } = require("@pulumi/pulumi/runtime/rpc");

require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(
  fs.readFileSync(filename, "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText, filename);

async function main() {
  const fixtureKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nZml4dHVyZQ==\n-----END OPENSSH PRIVATE KEY-----\n";
  const stack = yaml.load(fs.readFileSync(path.join(__dirname, "../Pulumi.local.yaml"), "utf8")).config;
  pulumi.runtime.setAllConfig({
    ...Object.fromEntries(Object.entries(stack).map(([key, value]) => [
      key, value?.secure ? "fixture-secret" : typeof value === "object" ? JSON.stringify(value) : String(value),
    ])),
    "forgejo:hostProvisionPrivateKey": fixtureKey,
  });
  let signalDeployment, releaseDeployment;
  const deploymentRegistered = new Promise(resolve => { signalDeployment = resolve; });
  const allowDeploymentReady = new Promise(resolve => { releaseDeployment = resolve; });
  let deploymentReady = false;
  const resources = [];
  await pulumi.runtime.setMocks({
    newResource: async args => {
      if (args.type === "kubernetes:apps/v1:Deployment" && args.name === "forgejo") {
        const [inputs] = unwrapSecretValues(args.inputs);
        assert.equal(inputs.spec.template.spec.containers[0].readinessProbe.httpGet.path, "/api/v1/version");
        signalDeployment();
        await allowDeploymentReady;
        deploymentReady = true;
      }
      if (args.type === "pulumi:providers:forgejo") {
        assert.ok(deploymentReady, "Forgejo provider configured before server readiness");
      }
      resources.push(args);
      return { id: args.name, state: {
        ...args.inputs, repositoryId: 2, teamId: 1,
        ...(args.type === "pulumi:pulumi:StackReference" ? { outputs: { reviewWebhookSecret: "fixture-secret" } } : {}),
        ...(args.type === "kubernetes:apps/v1:Deployment" ? { status: { readyReplicas: 1 } } : {}),
      } };
    },
    call: args => {
      assert.ok(deploymentReady, "Forgejo lookup ran before server readiness");
      if (args.token.includes("getTeam")) {
        return { ...args.inputs, permission: "owner", includesAllRepositories: true };
      }
      assert.deepEqual(args.inputs, { owner: "home", name: "homelab-iac" });
      return { ...args.inputs, id: 2 };
    },
  }, "infrastructure", "test", false);
  const monitor = pulumi.runtime.getMonitor();
  const register = monitor.registerResource.bind(monitor);
  monitor.registerResource = (request, callback) => {
    if (request.getType() === "pulumi:providers:forgejo") {
      const dependencies = request.getPropertydependenciesMap().get("host")?.getUrnsList() || [];
      if (!dependencies.some(urn => urn.endsWith("kubernetes:apps/v1:Deployment::forgejo"))) {
        return callback(new Error("Forgejo endpoint is missing its deployment readiness dependency"));
      }
    }
    return register(request, callback);
  };
  const { configureForgejo } = require("../workloads/forgejo/index.ts");
  await pulumi.runtime.runInPulumiStack(async () => {
    const app = configureForgejo();
    await deploymentRegistered;
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(!resources.some(r => r.type === "pulumi:providers:forgejo"));
    } finally {
      releaseDeployment();
    }
    const access = app.hostProvisionAccess;
    assert.equal(await pulumi.isSecret(access.key.data), true);
    assert.equal(await access.key.data.promise(), fixtureKey);
    assert.equal(await access.key.repositoryId.promise(), 2);
    assert.equal(await access.hostPin.repositoryId.promise(), 2);
    assert.equal(await access.hostPin.name.promise(), "HOST_SSH_KNOWN_HOSTS");
    const expectedPin = fs.readFileSync(path.join(__dirname, "../../ansible/roles/host_security/files/host-provision-known-hosts"), "utf8");
    assert.equal(await access.hostPin.data.promise(), expectedPin);
  });
  assert.equal(resources.filter(r => r.type === "pulumi:providers:forgejo").length, 2);
  const secrets = resources.filter(r => r.type === "forgejo:index/repositoryActionSecret:RepositoryActionSecret");
  assert.equal(secrets.length, 2);
  console.log("Validated Forgejo provider readiness, repository-scoped deployment secrets, and the pinned host key.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
