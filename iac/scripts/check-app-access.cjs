const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const yaml = require("js-yaml");
const pulumi = require("@pulumi/pulumi");
const k8s = require("@pulumi/kubernetes");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  module._compile(compiled.outputText, filename);
};

const stack = yaml.load(fs.readFileSync(path.join(__dirname, "../Pulumi.local.yaml"), "utf8")).config;
const stackApps = stack["privateAccess:apps"];
const publicTarget = "traefik.kube-system.svc.cluster.local";
const privateTarget = "traefik-tailnet.kube-system.svc.cluster.local";

function setConfig(apps, overrides = {}) {
  const values = {
    "privateAccess:apps": JSON.stringify(apps),
    "privateAccess:enabled": "true",
    ...overrides,
  };
  pulumi.runtime.setAllConfig(values);
}

const fixtureConfig = {
  "privateAccess:connectorDeviceId": "test-connector",
  "privateAccess:dnsClientId": "test-dns-client",
  "privateAccess:dnsClientSecret": "test-dns-secret",
  "tailscale:clientId": "test-client",
  "tailscale:clientSecret": "test-secret",
};
setConfig({ ...stackApps, "public.gdario.dev": "public" }, fixtureConfig);
const { appAccess, loadAppAccess } = require("../library/app-access.ts");
const { createLetsEncryptIngress } = require("../library/ingress.ts");
const { configureCoreDnsCustom } = require("../platform/core/coredns.ts");
const { configurePrivateAccess } = require("../platform/private-access.ts");

async function main() {
  // Exercise a real exposure transition: DNS, listeners, and split DNS must move together.
  for (const [mode, listeners, target, privateHosts] of [
    ["private", ["tailnet"], privateTarget, ["grafana.gdario.dev"]],
    ["both", ["websecure", "tailnet"], privateTarget, ["grafana.gdario.dev"]],
    ["public", ["websecure"], publicTarget, []],
  ]) {
    setConfig({ "grafana.gdario.dev": mode });
    const plan = loadAppAccess();
    assert.equal(plan.entryPoints("grafana.gdario.dev"), listeners.join(","));
    assert.deepEqual(plan.clusterDnsRewrites, [`rewrite stop name grafana.gdario.dev ${target}`]);
    assert.deepEqual(plan.privateHosts, privateHosts);
    assert.equal(plan.entryPoints("unlisted.gdario.dev"), "websecure");
  }

  for (const key of ["grafanaPrivate", "dualHosts", "publishDualDns", "approveRoutes", "publishDns"]) {
    setConfig({}, { [`privateAccess:${key}`]: key === "dualHosts" ? "[]" : "false" });
    assert.throws(loadAppAccess, /Replace privateAccess:/);
  }
  for (const apps of [null, [], "private", { "grafana.gdario.dev": "privte" }, { "grafana.gdario.dev\nrewrite": "private" }]) {
    setConfig(apps);
    assert.throws(loadAppAccess, /Invalid|must map/);
  }
  setConfig({ "grafana.gdario.dev": "private" }, { "privateAccess:enabled": "false" });
  assert.throws(loadAppAccess, /requires privateAccess:enabled/);
  setConfig({ "grafana.gdario.dev": "both" }, { "privateAccess:enabled": "false" });
  assert.throws(loadAppAccess, /requires privateAccess:enabled/);

  assert.equal(stackApps["grafana.gdario.dev"], "private");
  assert.equal(stackApps["auth.gdario.dev"], "private");
  assert.equal(stackApps["pulp.gdario.dev"], "private");
  assert.ok(Object.values(stackApps).every(mode => mode === "private"));
  for (const key of ["grafanaPrivate", "dualHosts", "publishDualDns", "approveRoutes", "publishDns"]) {
    assert.equal(stack[`privateAccess:${key}`], undefined);
  }

  const resources = [];
  await pulumi.runtime.setMocks({
    newResource: args => {
      resources.push(args);
      const state = { ...args.inputs };
      if (args.type === "kubernetes:core/v1:Service") {
        state.spec = { ...state.spec, clusterIP: args.name === "traefik-tailnet" ? "10.43.0.20" : "10.43.0.21" };
      }
      return { id: `${args.name}-id`, state };
    },
    call: args => args.inputs,
  }, "infrastructure", "test", false);

  // Resource builders keep the original plan even after config changes in the scenarios above.
  assert.equal(appAccess.entryPoints("grafana.gdario.dev"), "tailnet");
  setConfig({ ...stackApps, "public.gdario.dev": "public" }, fixtureConfig);
  const { privateHosts } = appAccess;
  const operator = {
    namespace: "tailscale",
    defaultDeny: new k8s.networking.v1.NetworkPolicy("test-default-deny", {
      metadata: { namespace: "tailscale" }, spec: { podSelector: {}, policyTypes: ["Ingress"] },
    }),
    chart: {
      getResource: () => new k8s.apiextensions.CustomResource("test-connector-crd", {
        apiVersion: "apiextensions.k8s.io/v1", kind: "CustomResourceDefinition", metadata: { name: "connectors.tailscale.com" },
      }),
    },
  };
  assert.throws(() => configurePrivateAccess(undefined), /requires tailscale:enabled/);
  assert.throws(() => configurePrivateAccess(operator, [{ host: "grafana.gdario.dev", address: "10.43.0.30" }]), /unique hosts/);
  assert.throws(() => configurePrivateAccess(operator, [
    { host: "codex.gdario.dev", address: "10.43.0.30" },
    { host: "codex.gdario.dev", address: "10.43.0.31" },
  ]), /unique hosts/);

  await pulumi.runtime.runInPulumiStack(async () => {
    const ingresses = ["grafana", "auth", "public"].map(name => createLetsEncryptIngress({
      name, namespace: "test", host: `${name}.gdario.dev`, serviceName: name,
      targetPort: 3000, podSelector: { app: name },
    }));
    const coreDns = configureCoreDnsCustom();
    const access = configurePrivateAccess(operator, [{ host: "codex.gdario.dev", address: pulumi.output("10.43.0.30") }]);
    await pulumi.all([
      coreDns.data, ...ingresses.map(item => item.ingress.metadata),
      access.https.spec, access.dns.spec, ...access.dnsRecords.map(item => item.nameservers),
    ]).promise();
  });

  const resource = (type, name) => {
    const match = resources.find(item => item.type === type && item.name === name);
    assert.ok(match, `Missing ${type} ${name}`);
    return match.inputs;
  };
  for (const [name, entrypoints] of [["grafana", "tailnet"], ["auth", "tailnet"], ["public", "websecure"]]) {
    const ingress = resource("kubernetes:networking.k8s.io/v1:Ingress", `${name}-ingress`);
    assert.equal(ingress.metadata.annotations["traefik.ingress.kubernetes.io/router.entrypoints"], entrypoints);
    assert.equal(ingress.spec.tls[0].secretName, `${name}-tls-cert`);
    assert.ok(resource("kubernetes:networking.k8s.io/v1:NetworkPolicy", `${name}-allow-traefik`));
  }
  assert.equal(resources.filter(item => item.type === "kubernetes:networking.k8s.io/v1:Ingress").length, 3);
  const rewrites = resource("kubernetes:core/v1:ConfigMap", "coredns-custom").data["rewrite.override"];
  for (const host of privateHosts) {
    assert.ok(rewrites.includes(`rewrite stop name ${host} ${privateTarget}\n`));
  }
  assert.ok(rewrites.includes(`rewrite stop name public.gdario.dev ${publicTarget}\n`));
  assert.ok(rewrites.includes("rewrite stop name pulp-ci.gdario.dev pulp.selfhosted.svc.cluster.local\n"));
  assert.ok(!rewrites.includes("_acme-challenge"));

  const corefile = resource("kubernetes:core/v1:ConfigMap", "private-access-dns").data.Corefile;
  assert.ok(corefile.includes(`10.43.0.20 ${privateHosts.join(" ")}`));
  assert.ok(corefile.includes("10.43.0.30 codex.gdario.dev"));
  assert.ok(!corefile.includes("public.gdario.dev"));
  const splitDns = resources.filter(item => item.type === "tailscale:index/dnsSplitNameservers:DnsSplitNameservers");
  assert.deepEqual(splitDns.map(item => item.inputs.domain).sort(), [...privateHosts, "codex.gdario.dev"].sort());
  assert.ok(splitDns.every(item => item.inputs.nameservers[0] === "10.43.0.21"));
  assert.ok(resource("tailscale:index/deviceSubnetRoutes:DeviceSubnetRoutes", "private-access-routes"));
  const privateService = resource("kubernetes:core/v1:Service", "traefik-tailnet");
  assert.equal(privateService.spec.type, "ClusterIP");
  assert.equal(privateService.spec.ports[0].targetPort, "tailnet");
  console.log("Validated access transitions, fail-closed configuration, ingress resources, cluster DNS, and Tailscale DNS.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
