import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const CORE = path.join(REPO, "packages/core/src");
const read = (rel) => fs.readFileSync(path.join(CORE, rel), "utf8");
const lines = (rel) => read(rel).split(/\r?\n/).length - 1;

const mem = read("context/memoryContextManager.ts");
const sys = read("context/system-context.ts");

// 1. 记忆分组 4 个
const groups = new Set((mem.match(/this\.(global|plugin|local|project)Memory =/g) ?? []).map((m) => m.replace(/this\.|Memory =/g, "")));
console.log("memory groups:", groups.size, [...groups].join(","));

// 2. 三层加载：global/project/JIT
const layers = ["discoverMemoryPaths", "loadMemoryContents", "discoverContext"].filter((k) => mem.includes(k));
console.log("memory layers:", layers.length);

// 3. 系统上下文的三个防坑点
const guards = [
  "cachedEntry.promise",
  "evictAfterSettle",
  "must not poison the cache",
].filter((k) => sys.includes(k));
console.log("system context guards:", guards.length);

// 4. 存的是 Promise
console.log("concurrent flight cache:", /cachedPromises\.set\(cacheKey, cacheEntry\)/.test(sys) && /promise,/.test(sys));

// 5. 信任判定次数
console.log("trust checks:", (mem.match(/isTrustedFolder\(\)/g) ?? []).length);

// 6. 行数
for (const f of [
  "context/memoryContextManager.ts",
  "context/system-context.ts",
  "attachments/get-attachments.ts",
  "attachments/generators/file-generators.ts",
]) {
  console.log(String(lines(f)).padStart(5), f);
}
