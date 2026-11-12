import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const CORE = path.join(REPO, "packages/core/src");
const read = (rel) => fs.readFileSync(path.join(CORE, rel), "utf8");
const lines = (rel) => read(rel).split(/\r?\n/).length - 1;
const uniq = (re, text) => [...new Set(text.match(re) ?? [])];
const branches = (text, header) => {
  const rows = text.split(/\r?\n/);
  const start = rows.findIndex((r) => r.includes(header));
  let n = 0;
  for (let i = start + 1; i < rows.length; i++) {
    if (/^ +\| /.test(rows[i])) n++;
    else if (n > 0) break;
  }
  return n;
};

const convHandler = read("event-bus/conversation-handler.ts");
const events = read("event-bus/events.ts");
const state = read("event-bus/state.ts");

const subs = convHandler.match(/bus\.subscribe\([\s\S]*?\]/)[0];
console.log("subscribes:", uniq(/'[a-z]+\.[a-z_]+'/g, subs).length);

const cases = convHandler.match(/case '[a-z]+\.[a-z_]+':/g) ?? [];
console.log("dispatch cases:", uniq(/'[a-z]+\.[a-z_]+'/g, cases.join()).length);

console.log("ToolContinuation kinds:", branches(state, "export type ToolContinuation"));
console.log("RequestReason:", branches(events, "export type RequestReason"));
console.log("Terminal.reason:", branches(read("core/query-event.ts"), "export interface Terminal"));
console.log("ReasonDetail:", branches(read("core/query-terminal.ts"), "export type TaskTerminalReasonDetail"));
console.log("turn stages:", uniq(/'turn\.[a-z.]+'/g, read("core/turn-hooks.ts")).length);

for (const f of [
  "core/query-turn.ts", "core/query-terminal.ts", "core/turn-budget.ts",
  "event-bus/state.ts", "event-bus/conversation-handler.ts",
  "event-bus/conversation/model-settled.ts",
  "event-bus/conversation/tools-settled.ts",
]) {
  console.log(String(lines(f)).padStart(5), f);
}
