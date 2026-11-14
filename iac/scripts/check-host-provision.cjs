const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const pulumi = require("@pulumi/pulumi");
const forgejo = require("@pulumi/forgejo");

require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(
  fs.readFileSync(filename, "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText, filename);

async function main() {
  const fixtureKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nZml4dHVyZQ==\n-----END OPENSSH PRIVATE KEY-----\n";
  pulumi.runtime.setAllConfig({ "forgejo:hostProvisionPrivateKey": fixtureKey });
  const resources = [];
  await pulumi.runtime.setMocks({
    newResource: args => {
      resources.push(args);
      return { id: args.name, state: args.inputs };
    },
    call: args => {
      assert.deepEqual(args.inputs, { owner: "home", name: "homelab-iac" });
      return { ...args.inputs, id: 2 };
    },
  }, "infrastructure", "test", false);
  const { configureHostProvisionAccess } = require("../workloads/forgejo/host-provision.ts");
  await pulumi.runtime.runInPulumiStack(async () => {
    const access = configureHostProvisionAccess(new forgejo.Provider("fixture-provider", {
      host: "https://git.example.test", apiToken: "fixture-token",
    }));
    assert.equal(await pulumi.isSecret(access.key.data), true);
    assert.equal(await access.key.data.promise(), fixtureKey);
    assert.equal(await access.key.repositoryId.promise(), 2);
    assert.equal(await access.hostPin.repositoryId.promise(), 2);
    assert.equal(await access.hostPin.name.promise(), "HOST_SSH_KNOWN_HOSTS");
    const expectedPin = fs.readFileSync(path.join(__dirname, "../../ansible/roles/host_security/files/host-provision-known-hosts"), "utf8");
    assert.equal(await access.hostPin.data.promise(), expectedPin);
  });
  const secrets = resources.filter(r => r.type === "forgejo:index/repositoryActionSecret:RepositoryActionSecret");
  assert.equal(secrets.length, 2);
  console.log("Validated repository-scoped host deployment secrets, secret propagation, and the pinned host key.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
