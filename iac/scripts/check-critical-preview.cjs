const { readFileSync } = require("node:fs");

const criticalResources = new Set([
  "urn:pulumi:local::infrastructure::kubernetes:apps/v1:StatefulSet::shared-postgres",
  "urn:pulumi:local::infrastructure::kubernetes:core/v1:PersistentVolumeClaim::shared-postgres-pvc",
  "urn:pulumi:local::infrastructure::kubernetes:apps/v1:Deployment::authentik-server",
  "urn:pulumi:local::infrastructure::kubernetes:apps/v1:Deployment::authentik-worker",
]);

let preview;
try {
  preview = JSON.parse(readFileSync(0, "utf8"));
} catch {
  console.error("Expected JSON output from Pulumi preview.");
  process.exit(1);
}

const errors = preview?.diagnostics?.filter(({ severity }) => severity === "error") ?? [];
if (errors.length > 0) {
  for (const { message } of errors) console.error(message);
  process.exit(1);
}

if (!Array.isArray(preview?.steps) || !preview.changeSummary || preview.maybeCorrupt ||
    preview.steps.some(step => typeof step?.urn !== "string" || typeof step.op !== "string")) {
  console.error("Pulumi preview did not report a complete update.");
  process.exit(1);
}

const allowedOperations = new Set(["same", "create", "update"]);
const blocked = preview.steps.filter(({ urn, op }) =>
  criticalResources.has(urn) && !allowedOperations.has(op));

if (blocked.length > 0) {
  for (const { urn, op } of blocked) console.error(`Blocked Pulumi operation ${op} on ${urn}`);
  console.error("Changes that replace or remove critical resources require a reviewed maintenance change.");
  process.exit(1);
}

console.log("Pulumi preview passed the critical resource gate.", preview.changeSummary);
