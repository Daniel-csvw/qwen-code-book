// Q02 验证：cli/src/framework 有几个 AppFramework 子类
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const d = fs.readdirSync(path.join(REPO, "packages/cli/src/framework"));
const subs = d.filter((f) => /AppFramework\.ts$/.test(f) && f !== "appFramework.ts");
console.log(subs.length, "AppFramework subclasses:", subs.join(", "));
