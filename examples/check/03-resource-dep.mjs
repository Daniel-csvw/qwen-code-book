// Q02 验证：core 怎么声明 resource
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "packages/core/package.json"), "utf8"));
console.log("@qwen-code/resource =", pkg.dependencies["@qwen-code/resource"]);
