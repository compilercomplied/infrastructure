const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");

async function request(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Helm download returned HTTP ${response.status}: ${url}`);
  return response;
}

async function main() {
  const [chart, version, repo] = process.argv.slice(2);
  if (!/^[a-z0-9-]+$/.test(chart) || !/^[a-zA-Z0-9.+-]+$/.test(version) || !repo?.startsWith("https://")) {
    throw new Error("Expected chart name, exact version and HTTPS repository URL");
  }
  const index = yaml.load(await (await request(`${repo}/index.yaml`)).text());
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

  // The official API avoids GitHub's failing web-download edge without trusting a mirror.
  const url = entry.urls?.find(value => value.startsWith("https://github.com/"));
  const match = url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/?]+)$/);
  if (!match) throw new Error(`Unsupported official release URL for ${chart} ${version}`);
  const [, repository, tag, filename] = match;
  const release = await (await request(`https://api.github.com/repos/${repository}/releases/tags/${tag}`)).json();
  const asset = release.assets?.find(item => item.name === filename);
  if (!asset || !Number.isSafeInteger(asset.id)) throw new Error(`Missing release asset: ${filename}`);
  const response = await request(`https://api.github.com/repos/${repository}/releases/assets/${asset.id}`, {
    Accept: "application/octet-stream",
    "X-GitHub-Api-Version": "2022-11-28",
  });
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
