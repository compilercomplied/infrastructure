const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { forgejoVersion: version, forgejoAssets: assets } = require("./ci-tools.cjs");
const { fetchMirrored } = require("./pulp-download.cjs");

async function main() {
  const project = await fs.readFile(path.join(__dirname, "../Pulumi.yaml"), "utf8");
  const declared = project.match(/^\s+- svalabs\/forgejo\r?\n\s+- (\S+)\s*$/m)?.[1];
  if (declared !== version) {
    throw new Error(`Forgejo provider pin differs from Pulumi.yaml (${declared}); update the asset and SHA256 pins together.`);
  }
  const platform = `${process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`;
  const expected = assets[platform];
  if (!expected) throw new Error(`Unsupported Forgejo provider platform: ${platform}. Supported: ${Object.keys(assets).join(", ")}`);

  const home = process.env.PULUMI_HOME || path.join(os.homedir(), ".pulumi");
  const cache = path.join(home, "dynamic_tf_plugins/registry.opentofu.org/svalabs/forgejo", version, platform);
  const binary = `terraform-provider-forgejo_v${version}`;
  const target = path.join(cache, binary);
  try {
    await fs.access(target, constants.X_OK);
    console.log(`Forgejo ${version}: using ${target}`);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const unzip = spawnSync("unzip", ["-v"], { stdio: "ignore" });
  if (unzip.error || unzip.status !== 0) throw new Error("Forgejo provider cache setup requires unzip on PATH.");

  const filename = `terraform-provider-forgejo_${version}_${platform}.zip`;
  const upstream = `https://github.com/svalabs/terraform-provider-forgejo/releases/download/v${version}/${filename}`;
  const response = await fetchMirrored(`forgejo/${version}/${filename}`, upstream);
  const archive = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new Error(`Forgejo archive SHA256 mismatch: expected ${expected}, got ${actual}`);
  console.log(`Forgejo ${version} ${platform}: verified archive SHA256 ${actual}`);

  await fs.mkdir(cache, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(cache, ".download-"));
  try {
    const zip = path.join(temporary, "provider.zip");
    const extracted = path.join(temporary, binary);
    await fs.writeFile(zip, archive);
    const output = await fs.open(extracted, "wx", 0o700);
    try {
      // Never unpack arbitrary archive paths into the plugin cache.
      const result = spawnSync("unzip", ["-p", zip, binary], { stdio: ["ignore", output.fd, "pipe"] });
      if (result.error || result.status !== 0) throw new Error(`Cannot extract ${binary}: ${result.error?.message || result.stderr.toString().trim()}`);
    } finally {
      await output.close();
    }
    if ((await fs.stat(extracted)).size === 0) throw new Error(`Empty provider binary: ${binary}`);
    await fs.rename(extracted, target);
    console.log(`Forgejo ${version}: cached ${target}`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
