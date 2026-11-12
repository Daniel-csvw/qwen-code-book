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
    if (/^ {2,}\w+ = '/.test(rows[i]) || /^ {2,}\| '/.test(rows[i])) n++;
    else if (n > 0 && rows[i].trim() === "") continue;
    else if (n > 0 && !/^ {2,}/.test(rows[i])) break;
  }
  return n;
};

const types = read("hooks/types.ts");
const toolCheck = read("permissions/manager/tool-check.ts");
const pm = read("permissions/manager/permission-manager.ts");

// 1. 钩子事件几个？应为 29
const he = types.match(/export enum HookEventName \{[\s\S]*?\n\}/)[0];
console.log("hook events:", (he.match(/^  \w+ = '/gm) ?? []).length);

// 2. HookType 几个？应为 5
const ht = types.match(/export enum HookType \{[\s\S]*?\n\}/)[0];
console.log("hook types:", (ht.match(/^  \w+ = '/gm) ?? []).length);

// 3. ConfigSource 几个？应为 7
const cs = types.match(/export enum ConfigSource \{[\s\S]*?\n\}/)[0];
console.log("config sources:", (cs.match(/^  \w+ = '/gm) ?? []).length);

// 4. PermissionModes 几个？应为 5
const modesFile = read("hooks/types.ts");
const pmModes = pm.match(/\[PermissionModes\.\w+\]: \{/g) ?? [];
console.log("permission modes:", new Set(pmModes).size);

// 5. runChecker catch -> deny
const rc = toolCheck.match(/private async runChecker\([\s\S]*?\n  \}/)[0];
console.log("checker catch -> deny:", /catch \{\s*return \{ kind: 'deny' \}/.test(rc));

// 6. ask without handler -> deny
console.log("ask without handler -> deny:", /this\.askHandler === undefined[\s\S]{0,80}'deny'/.test(toolCheck));

// 7. 行数
for (const f of [
  "hooks/types.ts",
  "hooks/hookRunner.ts",
  "hooks/hookEventHandler.ts",
  "permissions/manager/tool-check.ts",
  "permissions/manager/permission-manager.ts",
  "permissions/permission-modes/auto/dangerous-rules.ts",
]) {
  console.log(String(lines(f)).padStart(5), f);
}
