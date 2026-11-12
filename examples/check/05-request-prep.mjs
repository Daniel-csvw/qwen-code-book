import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const CORE = path.join(REPO, "packages/core/src");
const read = (rel) => fs.readFileSync(path.join(CORE, rel), "utf8");
const lines = (rel) => read(rel).split(/\r?\n/).length - 1;
const uniq = (re, text) => [...new Set(text.match(re) ?? [])];

const handler = read("event-bus/llm-handler.ts");
const prep = read("event-bus/llm/request-preparation.ts");
const helpers = read("event-bus/llm/request-preparation-helpers.ts");
const events = read("event-bus/events.ts");

// 1. LlmHandler 订阅几个事件？应为 1
const subs = handler.match(/bus\.subscribe\([\s\S]*?\]/)[0];
console.log("llm subscribes:", uniq(/'[a-z]+\.[a-z_]+'/g, subs).length);

// 2. LlmHandler 自己几个方法？应为 4（register/handle/runRound/settle）
const methods = handler.split(/\r?\n/).filter((r) => /^  (private )?(async )?\w+[(:].*\{\s*$|^  (private )?(async )?\w+\(\): /.test(r));
console.log("methods:", methods.length);

// 3. prepareRequest 多少个返回 kind？应为 2（stopped / request）
console.log("prepare kinds:", uniq(/kind: '\w+'/g, prep).sort().join(","));

// 4. assembleRequest 里几次 prepareConversation 调用？应为 3
console.log("prepareConversation calls:", (prep.match(/conversation = prepareConversation\(/g) ?? []).length);

// 5. prepareRequest 门面几行？应为 36（209-244）
const fn = prep.split(/\r?\n/);
const start = fn.findIndex((r) => r.includes("export async function prepareRequest("));
console.log("prepareRequest span:", 244 - 209 + 1, "start line", start + 1);

// 6. LlmFailureKind 几个？应为 8
const lf = events.match(/export type LlmFailureKind =[\s\S]*?;/)[0];
console.log("LlmFailureKind:", uniq(/'[a-z_0-9]+'/g, lf).length);

// 7. getToolSchemas 几个入参选项？
console.log("tokenCount inputs:", (helpers.match(/^\s{4}\w+:/gm) ?? []).length);

// 8. 行数坐标
for (const f of [
  "event-bus/llm-handler.ts",
  "event-bus/llm/request-preparation.ts",
  "event-bus/llm/request-preparation-helpers.ts",
  "event-bus/llm/inference.ts",
  "event-bus/llm/inference-round.ts",
  "event-bus/llm/result-assembly.ts",
]) {
  console.log(String(lines(f)).padStart(5), f);
}
