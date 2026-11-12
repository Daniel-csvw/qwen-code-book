import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const CORE = path.join(REPO, "packages/core/src");
const read = (rel) => fs.readFileSync(path.join(CORE, rel), "utf8");
const lines = (rel) => read(rel).split(/\r?\n/).length - 1;
const branches = (text, header) => {
  const rows = text.split(/\r?\n/);
  const start = rows.findIndex((r) => r.includes(header));
  let n = 0;
  for (let i = start + 1; i < rows.length; i++) {
    if (/^ {2,}\| '/.test(rows[i])) n++;
    else if (n > 0) break;
  }
  return n;
};

const types = read("compression-v2/types.ts");
const ac = read("compression-v2/auto-compact.ts");

console.log("failure reasons:", branches(types, "export type CompactionFailureReason"));
const br = types.match(/export type BlockingCompactionFailureReason =[\s\S]*?;/)[0];
console.log("blocking reasons:", (br.match(/'[a-z_]+'/g) ?? []).length);

const ub = ac.match(/function formatUsageBucket[\s\S]*?\n\}/)[0];
console.log("usage buckets:", (ub.match(/return '/g) ?? []).length);

const rb = ac.match(/function formatReductionBucket[\s\S]*?\n\}/)[0];
console.log("reduction buckets:", (rb.match(/return '/g) ?? []).length);

console.log("exhaustive record:", /Record<\s*BlockingCompactionFailureReason,\s*true\s*>/.test(types));
console.log("breaker persisted:", /AutoCompactTrackingState[\s\S]{0,400}persisted/i.test(types) ? true : false);

for (const f of [
  "compression-v2/types.ts",
  "compression-v2/pipeline.ts",
  "compression-v2/auto-compact.ts",
  "compression-v2/fork-compact.ts",
  "compression-v2/post-compact-finalize.ts",
  "compression-v2/apply-post-compact.ts",
]) {
  console.log(String(lines(f)).padStart(5), f);
}
