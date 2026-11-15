const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const yaml = require("js-yaml");
const pulumi = require("@pulumi/pulumi");
const k8s = require("@pulumi/kubernetes");

require.extensions[".ts"] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  module._compile(compiled.outputText, filename);
};

// Retain the configuration shape without decrypting or using production secrets.
const { keycloakBaseUrl } = require("../library/oidc-app.ts");
const stack = yaml.load(fs.readFileSync(path.join(__dirname, "../Pulumi.local.yaml"), "utf8")).config;
pulumi.runtime.setAllConfig(Object.fromEntries(Object.entries(stack).map(([key, value]) => [
  key, value && typeof value === "object" && "secure" in value ? "test-secret" :
    typeof value === "object" ? JSON.stringify(value) : String(value),
])));

async function main() {
  const resources = [];
  await pulumi.runtime.setMocks({
    newResource: args => { resources.push(args); return { id: `${args.name}-id`, state: args.inputs }; },
    call: args => args.inputs,
  }, "infrastructure", "test", false);
  const { SelfhostedApp } = require("../library/selfhosted-component.ts");
  const { configureSelfhosted } = require("../workloads/selfhosted/index.ts");
  await pulumi.runtime.runInPulumiStack(async () => {
    const database = name => new k8s.core.v1.Service(name, {
      metadata: { name, namespace: "shared-resources" }, spec: { ports: [{ port: 5432 }] },
    });
    const apps = configureSelfhosted(database("postgres"), database("mariadb"));
    const fixture = new SelfhostedApp("security-fixture", {
      namespace: "test", image: "fixture:1", endpoints: [{ name: "http", containerPort: 8080 }],
      podSecurityContext: { runAsUser: 700, fsGroup: 700 },
      containerSecurityContext: { runAsNonRoot: true, readOnlyRootFilesystem: true },
      initContainers: [{ name: "init", image: "fixture:1" }],
      additionalContainers: [
        { name: "ordinary", image: "fixture:1", securityContext: { capabilities: { add: ["CHOWN"] } } },
        { name: "dind", image: "fixture:1", securityContext: { privileged: true } },
        { name: "sandbox", image: "fixture:1", securityContext: {
          allowPrivilegeEscalation: true, capabilities: { drop: [] },
          seccompProfile: { type: "Unconfined" }, appArmorProfile: { type: "Unconfined" },
        } },
      ],
    });
    const deployments = [fixture, apps.tandoor, apps.linkwarden, apps.grimmory, apps.outline.outline,
      apps.outline.redis, apps.outline.minio, apps.ntfy, apps.memos, apps.windshift, apps.excalidash, apps.doop, apps.pulp];
    await pulumi.all([
      apps.memos.deploymentConfig.stringData,
      ...deployments.map(app => app.deployment.spec), apps.cloudflared.spec,
      ...deployments.flatMap(app => app.backupJobs || []).map(job => job.spec),
      apps.windshift.bootstrap.spec,
    ]).promise();
  });

  const unwrap = value => {
    if (pulumi.runtime.isRpcSecret(value)) return unwrap(pulumi.runtime.unwrapRpcSecret(value));
    if (Array.isArray(value)) return value.map(unwrap);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrap(v)]));
    return value;
  };
  const memosConfig = unwrap(resources.find(r => r.type === "kubernetes:core/v1:Secret" && r.name === "memos-deployment-config").inputs).stringData;
  const provider = JSON.parse(memosConfig["memos-idp-keycloak.json"]);
  assert.equal(provider.uid, "keycloak");
  assert.equal(provider.name, "Keycloak");
  assert.equal(memosConfig["memos-idp-authentik.json"], undefined);
  const endpoints = provider.config.oauth2Config;
  assert.equal(endpoints.fieldMapping.identifier, "sub");
  assert.equal(endpoints.authUrl, `${keycloakBaseUrl}/realms/homelab/protocol/openid-connect/auth`);
  assert.equal(endpoints.tokenUrl, `${keycloakBaseUrl}/realms/homelab/protocol/openid-connect/token`);
  assert.equal(endpoints.userInfoUrl, `${keycloakBaseUrl}/realms/homelab/protocol/openid-connect/userinfo`);
  assert.deepEqual(endpoints.scopes, ["openid", "profile", "email"]);
  assert.deepEqual(JSON.parse(memosConfig["memos-instance-setting-general.json"]).generalSetting, {
    disallowUserRegistration: true, disallowPasswordAuth: true,
  });
  assert.equal(JSON.parse(memosConfig["memos-instance-setting-access.json"]).accessSetting.accessMode, "INSTANCE_ACCESS_MODE_PRIVATE");
  const memos = unwrap(resources.find(r => r.type === "kubernetes:apps/v1:Deployment" && r.name === "memos").inputs);
  assert.equal(memos.spec.template.metadata.labels["network/allow-authentik"], undefined);
  const podSpecs = resources.flatMap(({ type, name, inputs: rawInputs }) => {
    const inputs = unwrap(rawInputs);
    if (type === "kubernetes:apps/v1:Deployment" || type === "kubernetes:batch/v1:Job") {
      return [{ name, pod: inputs.spec.template.spec, type }];
    }
    if (type === "kubernetes:batch/v1:CronJob") return [{ name, pod: inputs.spec.jobTemplate.spec.template.spec, type }];
    return [];
  });
  assert.equal(podSpecs.filter(({ name, type }) => name !== "security-fixture" && type === "kubernetes:apps/v1:Deployment").length, 13);
  for (const name of ["init-doop-db", "outline-minio-setup", "patch-grimmory-db", "windshift-bootstrap"]) {
    assert.ok(podSpecs.some(p => p.name === name), `Missing ${name}`);
  }
  let checked = 0;
  for (const { name, pod } of podSpecs) {
    assert.equal(pod.securityContext.seccompProfile.type, "RuntimeDefault", name);
    for (const container of [...(pod.initContainers || []), ...pod.containers]) {
      const context = container.securityContext;
      assert.ok(context, `${name}/${container.name}`);
      if (name === "security-fixture" && container.name === "dind") {
        assert.deepEqual(context, { privileged: true });
      } else if (name === "security-fixture" && container.name === "sandbox") {
        assert.equal(context.allowPrivilegeEscalation, true);
        assert.deepEqual(context.capabilities.drop, []);
        assert.equal(context.seccompProfile.type, "Unconfined");
        assert.equal(context.appArmorProfile.type, "Unconfined");
      } else {
        assert.equal(context.privileged, false, `${name}/${container.name}`);
        assert.equal(context.allowPrivilegeEscalation, false, `${name}/${container.name}`);
        assert.deepEqual(context.capabilities.drop, ["ALL"], `${name}/${container.name}`);
      }
      checked++;
    }
  }
  const fixture = podSpecs.find(p => p.name === "security-fixture").pod;
  assert.equal(fixture.securityContext.runAsUser, 700);
  assert.equal(fixture.securityContext.fsGroup, 700);
  assert.equal(fixture.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.equal(fixture.containers[0].securityContext.runAsNonRoot, true);
  assert.deepEqual(fixture.containers[1].securityContext.capabilities.add, ["CHOWN"]);
  const tandoor = podSpecs.find(p => p.name === "tandoor-recipes").pod.containers[0];
  assert.deepEqual(tandoor.securityContext.capabilities.add, ["CHOWN", "SETUID", "SETGID", "KILL"]);
  assert.equal(tandoor.command, undefined);
  assert.equal(tandoor.args, undefined);
  const minio = podSpecs.find(p => p.name === "outline-minio").pod;
  const minioSetup = podSpecs.find(p => p.name === "outline-minio-setup").pod;
  assert.equal(minioSetup.containers[0].image, minio.containers[0].image);
  for (const { name, pod } of podSpecs.filter(p => p.name.includes("-pvc-"))) {
    assert.deepEqual(pod.containers[0].securityContext.capabilities.add, ["DAC_READ_SEARCH"], name);
    assert.ok(pod.containers[0].volumeMounts.some(m => m.name === "backup-source-volume" && m.readOnly));
  }
  console.log(`Validated security contexts for ${checked} containers in ${podSpecs.length} app, bootstrap and backup pod templates.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
