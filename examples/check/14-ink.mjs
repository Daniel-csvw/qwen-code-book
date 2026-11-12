import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const INK = path.join(REPO, "packages/cli/src/ink");
const read = (f) => fs.readFileSync(path.join(INK, f), "utf8");
const lines = (f) => read(f).split(/\r?\n/).length - 1;

const files = fs.readdirSync(INK).filter((f) => f.endsWith(".ts") && !f.includes(".test."));
console.log("ink files:", files.length);

const r = read("renderer.ts");
console.log("vendored fork:", r.includes("vendored fork"));
console.log("double buffer:", r.includes("frontFrame") && r.includes("backFrame"));

const lu = read("log-update.ts");
const csiStart = lu.indexOf('from \'./termio/csi.js\'');
const csiBlock = lu.slice(lu.lastIndexOf('import', csiStart), csiStart);
const csiNames = (csiBlock.match(/^  [A-Za-z_]+/gm) ?? []).length;
console.log("csi imports:", csiNames);

for (const f of [
  "render-node-to-output.ts", "screen.ts", "parse-keypress.ts",
  "log-update.ts", "wrapAnsi.ts", "stringWidth.ts",
]) {
  console.log(String(lines(f)).padStart(5), f);
}
