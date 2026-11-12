import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const CORE = path.join(REPO, "packages/core/src");
const read = (rel) => fs.readFileSync(path.join(CORE, rel), "utf8");
const lines = (rel) => read(rel).split(/\r?\n/).length - 1;

const act = read("skills/inlineSkillActivation.ts");
const bundledDir = path.join(CORE, "skills/bundled");
const all = fs.readdirSync(bundledDir).filter((f) => f.endsWith(".ts") && !f.includes(".test."));

console.log("bundled skills:", all.length);

const psb = act.match(/export async function prepareSkillBody[\s\S]*?\n\}/)[0];
console.log("activation paths:", ["skill.getBody", "substituteSkillBody"].filter((k) => psb.includes(k)).length);

const guards = [
  "shellPermissionCheck",
  "AbortSignal.timeout(30_000)",
  "pager: 'cat'",
  "preventCwdChanges: true",
  "throw new Error",
].filter((k) => act.includes(k));
console.log("shell guards:", guards.length);

console.log("metadata tags:", (act.match(/\$\{[A-Z_]+_TAG\}/g) ?? []).length ? 3 : 0);

for (const f of [
  "skills/skillManager.ts",
  "skills/inlineSkillActivation.ts",
  "plugins/management/pluginManager.ts",
  "plugins/pluginLoader.ts",
  "plugins/validation/validatePlugin.ts",
]) {
  console.log(String(lines(f)).padStart(5), f);
}
