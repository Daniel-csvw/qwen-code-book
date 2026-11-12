import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const CORE = path.join(REPO, "packages/core/src");
const t = fs.readFileSync(path.join(CORE, "tools/tools.ts"), "utf8");
const kind = t.match(/export enum Kind \{[\s\S]*?\n\}/)[0];
console.log("kind values:", (kind.match(/^  \w+ = '/gm) ?? []).length);
const ro = t.match(/READ_ONLY_KINDS: Kind\[\] = \[[\s\S]*?\] as const/)[0];
console.log("read only kinds:", (ro.match(/Kind\.\w+/g) ?? []).length);
const mu = t.match(/MUTATOR_KINDS: Kind\[\] = \[[\s\S]*?\] as const/)[0];
console.log("mutator kinds:", (mu.match(/Kind\.\w+/g) ?? []).length);
const ctor = t.match(/constructor\(\n    readonly name: string[\s\S]*?\n  \) \{\}/)[0];
console.log("ctor params:", (ctor.match(/readonly \w+/g) ?? []).length);
const dt = t.match(/export abstract class DeclarativeTool[\s\S]*?abstract build\(/)[0];
console.log("abstract methods:", (dt.match(/abstract \w+\(/g) ?? []).length);
for (const f of ["tools/tools.ts", "tools/tool-registry.ts", "tools/tool-names.ts"]) {
  console.log(String(fs.readFileSync(path.join(CORE, f), "utf8").split(/\r?\n/).length - 1).padStart(5), f);
}
