import { execFileSync } from "node:child_process";
import * as path from "node:path";

export function cachedHelmChart(source: { chart: string; version: string; fetchOpts: { repo: string } }): { path: string } {
  const script = path.join(__dirname, "../scripts/cache-helm-chart.cjs");
  const archive = execFileSync(process.execPath, [script, source.chart, source.version, source.fetchOpts.repo], {
    encoding: "utf8",
    timeout: 360000,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  return { path: archive };
}
