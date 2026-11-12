import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const CLI = path.join(REPO, "packages/cli/src");
const read = (rel) => fs.readFileSync(path.join(CLI, rel), "utf8");
const lines = (rel) => read(rel).split(/\r?\n/).length - 1;
const fw = read("framework/appFramework.ts");
const fm = fw.match(/export type FrameworkMode =[\s\S]*?;/)[0];
console.log("framework modes:", (fm.match(/'[a-zA-Z]+'/g) ?? []).length);
const subs = fs.readdirSync(path.join(CLI, "framework")).filter((f) => f.endsWith("AppFramework.ts") && f !== "appFramework.ts");
console.log("framework subclasses:", subs.length);
const abs = fw.match(/export abstract class AppFramework[\s\S]*?\n\}/)[0];
console.log("abstract members:", (abs.match(/^  abstract /gm) ?? []).length);
const cs = read("headless/controlStream.ts");
console.log("permission scopes:", (cs.match(/value === '(once|session|persist)'/g) ?? []).length);
const dc = cs.match(/function decodeCanUseToolResponse[\s\S]*?\n\}/)[0];
console.log("decision branches:", (dc.match(/return \{ decision:/g) ?? []).length);
for (const f of [
  "framework/appFramework.ts",
  "framework/headlessAppFramework.ts",
  "framework/acpAppFramework.ts",
  "framework/tuiAppFramework.ts",
  "headless/permission.ts",
  "headless/controlStream.ts",
]) {
  console.log(String(lines(f)).padStart(5), f);
}
