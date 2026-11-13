import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 定位不依赖 cwd：从脚本自身位置回到仓库根
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT, "sources/qwen-code-1.0.0-preview");
const CORE = path.join(REPO, "packages/core/src");
const read = (rel) => fs.readFileSync(path.join(CORE, rel), "utf8");
const lines = (rel) => read(rel).split(/\r?\n/).length - 1;

const EB = "event-bus";
let failed = 0;
const check = (label, got, want) => {
  const okLabel = got === want ? "OK" : "FAIL";
  if (got !== want) failed++;
  console.log(`[${okLabel}] ${label}: ${got}（应为 ${want}）`);
};

// 1. agent-loop.ts 有几行？应为 85
check("agent-loop.ts 行数", lines("core/agent-loop.ts"), 85);

// 2. 几个事件类型？应为 10
const ev = read(`${EB}/events.ts`);
const map = ev.match(/export interface QueryBusEventMap \{[\s\S]*?\n\}/)[0];
check("事件类型数", (map.match(/^  '[a-z]+\.[a-z_]+':/gm) ?? []).length, 10);

// 3. HandlerName 几个值？应为 4
const hn = ev.match(/export type HandlerName =[\s\S]*?;/)[0];
check("HandlerName 值个数", (hn.match(/'[a-z]+'/g) ?? []).length, 4);

// 4. LlmHandler 订阅几个事件？应为 1（只有 llm.request）
const llm = read(`${EB}/llm-handler.ts`);
const sub = llm.match(/subscribe\([\s\S]*?\]/)[0];
const subTypes = (sub.match(/'[a-z]+\.[a-z_]+'/g) ?? []).length;
check("Llm 订阅事件数", subTypes, 1);

// 5. bus.ts 用锁了吗？应为 false
const bus = read(`${EB}/bus.ts`);
check("uses lock", /Mutex|Semaphore|new Lock/.test(bus), false);

// 6. runtime 装几个 handler？应为 3
const rt = read(`${EB}/runtime.ts`);
check("handler 个数", (rt.match(/new (\w+)Handler/g) ?? []).length, 3);

// 7. 投递链用 NUL 分隔吗？应为 true
check("deliver 用 NUL 分隔 key", /\\u0000/.test(bus), true);

if (failed) {
  console.log(`\n${failed} 条断言不符，请检查快照版本`);
  process.exit(1);
}
console.log("\n全部断言通过（7/7）");
