const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const version = "1.7.0";
// Pins come from the official v1.7.0 SHA256SUMS release asset.
const assets = {
  linux_amd64: [644666685, "1234b9b826c205be582fca1c93c51b6220dbcba67cff46cecad1aa9ce90fa056"],
  linux_arm64: [644666755, "5d0b391e69113efe4cc5fd18c3faa1c4771f81c48dc18514f49b3972770d7a49"],
  darwin_amd64: [644666847, "9398f8a9900390f218ef11342330f4883e18a42b619af1cdcfc82df501867897"],
  darwin_arm64: [644666753, "812c66aa4b67ff8d3460e4c53097642f2a4657c3de07f1b3d69611ddd6036469"],
};

async function main() {
  const project = await fs.readFile(path.join(__dirname, "../Pulumi.yaml"), "utf8");
  const declared = project.match(/^\s+- svalabs\/forgejo\r?\n\s+- (\S+)\s*$/m)?.[1];
  if (declared !== version) {
    throw new Error(`Forgejo provider pin differs from Pulumi.yaml (${declared}); update the asset and SHA256 pins together.`);
  }
  const platform = `${process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`;
  const asset = assets[platform];
  if (!asset) throw new Error(`Unsupported Forgejo provider platform: ${platform}. Supported: ${Object.keys(assets).join(", ")}`);

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

  const [id, expected] = asset;
  const response = await fetch(`https://api.github.com/repos/svalabs/terraform-provider-forgejo/releases/assets/${id}`, {
    headers: { Accept: "application/octet-stream", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Forgejo release asset API returned HTTP ${response.status}`);
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
