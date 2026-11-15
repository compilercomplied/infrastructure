const fs = require("fs");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  module._compile(compiled.outputText, filename);
};

const { oidcApps, validateOidcApps } = require("../platform/core/oidc-apps.ts");
validateOidcApps();
process.stdout.write(`Validated ${oidcApps.length} native OIDC client registrations.\n`);
