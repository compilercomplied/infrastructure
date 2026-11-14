const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { pulumiVersion: version } = require("./ci-tools.cjs");
const { fetchMirrored } = require("./pulp-download.cjs");

async function main() {
  if (!["linux", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) {
    throw new Error(`Unsupported Pulumi platform: ${process.platform}/${process.arch}`);
  }
  const home = process.env.PULUMI_HOME || path.join(os.homedir(), ".pulumi");
  const bin = path.join(home, "bin");
  const filename = `pulumi-v${version}-${process.platform}-${process.arch}.tar.gz`;
  const checksumFile = `pulumi-${version}-checksums.txt`;
  const upstream = `https://github.com/pulumi/pulumi/releases/download/v${version}/`;
  const checksums = await (await fetchMirrored(`pulumi/${version}/${checksumFile}`, upstream + checksumFile)).text();
  const expected = checksums.split("\n").map(line => line.trim().split(/\s+/))
    .find(([, name]) => name === filename)?.[0];
  if (!/^[a-f0-9]{64}$/.test(expected || "")) throw new Error(`Missing Pulumi SHA256 for ${filename}`);
  const archive = Buffer.from(await (await fetchMirrored(`pulumi/${version}/${filename}`, upstream + filename)).arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== expected) {
    throw new Error(`Pulumi archive SHA256 mismatch: ${filename}`);
  }
  await fs.mkdir(home, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(home, ".install-"));
  try {
    const file = path.join(temporary, filename);
    await fs.writeFile(file, archive);
    execFileSync("tar", ["-xzf", file, "-C", temporary]);
    await fs.mkdir(bin, { recursive: true });
    const extracted = path.join(temporary, "pulumi");
    for (const name of await fs.readdir(extracted)) await fs.rename(path.join(extracted, name), path.join(bin, name));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  console.log(`Installed Pulumi ${version} from a verified archive in ${bin}`);
  if (process.env.GITHUB_PATH) await fs.appendFile(process.env.GITHUB_PATH, `${bin}\n`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
