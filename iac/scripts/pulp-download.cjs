const base = "https://pulp.gdario.dev/pulp/content/ci-tools/";

async function fetchMirrored(relativePath, upstream) {
  if (process.env.PULP_BOOTSTRAP !== "1") {
    const response = await fetch(new URL(relativePath, base), { signal: AbortSignal.timeout(120000) });
    if (response.ok) return response;
    if (response.status !== 404) throw new Error(`Pulp download returned HTTP ${response.status}: ${relativePath}`);
    // New version PRs must be previewable before their artifacts are mirrored by deployment.
    console.error(`Pulp has no ${relativePath}; fetching this new pin from its official source.`);
  }
  const response = await fetch(upstream, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Upstream download returned HTTP ${response.status}: ${upstream}`);
  return response;
}

module.exports = { fetchMirrored, base };
