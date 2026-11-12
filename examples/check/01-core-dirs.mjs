// Q02 验证：core/src 有几个顶层目录
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const n = fs
  .readdirSync(path.join(REPO, "packages/core/src"), { withFileTypes: true })
  .filter((e) => e.isDirectory()).length;
console.log(n, "top-level dirs in core/src");
