const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");

const { fetchMirrored } = require("./pulp-download.cjs");

async function main() {
  const [chart, version, repo] = process.argv.slice(2);
  if (!/^[a-z0-9-]+$/.test(chart) || !/^[a-zA-Z0-9.+-]+$/.test(version) || !repo?.startsWith("https://")) {
    throw new Error("Expected chart name, exact version and HTTPS repository URL");
  }
  const index = yaml.load(await (await fetchMirrored(`helm/${chart}/${version}/index.yaml`, `${repo}/index.yaml`)).text());
  const entry = index.entries?.[chart]?.find(item => item.version === version);
  if (!entry || !/^[a-f0-9]{64}$/i.test(entry.digest)) {
    throw new Error(`Missing SHA256 for ${chart} ${version} in ${repo}`);
  }
  const expected = entry.digest.toLowerCase();
  const cache = path.join(os.homedir(), ".cache", "homelab-helm");
  const target = path.join(cache, `${chart}-${version}-${expected}.tgz`);
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  try {
    if (digest(await fs.readFile(target)) === expected) return target;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  // Official release downloads avoid the API quota shared by CI jobs behind the home router.
  const url = entry.urls?.find(value => value.startsWith("https://github.com/"));
  if (!url || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/?]+$/.test(url)) {
    throw new Error(`Unsupported official release URL for ${chart} ${version}`);
  }
  const filename = new URL(url).pathname.split("/").pop();
  const response = await fetchMirrored(`helm/${chart}/${version}/${filename}`, url);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== expected) throw new Error(`Helm archive SHA256 mismatch: ${chart} ${version}`);
  await fs.mkdir(cache, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(cache, ".download-"));
  try {
    const file = path.join(temporary, "chart.tgz");
    await fs.writeFile(file, bytes);
    await fs.rename(file, target);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  return target;
}

main().then(file => console.log(file)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
