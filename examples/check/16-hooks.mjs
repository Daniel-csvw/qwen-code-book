import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
﻿// Q16 验证脚本：钩子输出契约与合并优先级
// 用法：node qw-examples/check/16-hooks.mjs

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const HOOKS = path.join(REPO, "packages/core/src/hooks");
const rel = (p) => p.replace(REPO + path.sep, "").replace(/\\/g, "/");

const read = (f) => fs.readFileSync(path.join(HOOKS, f), "utf8");
const lines = (f) => read(f).split(/\r?\n/).length - 1;

const schema = read("hookOutputSchema.ts");

// 1. permissionDecision 四值
const pm = schema.match(/const permissionBehaviorSchema = z\.enum\(\[([^\]]+)\]\)/);
const decisions = pm[1].split(",").map((s) => s.replace(/[\x27"\s]/g, "")).filter(Boolean);
console.log("permission decisions:", decisions.length, "->", decisions.join(" / "));

// 2. 逐字段统计 hookSpecificOutput 变体
const blockOf = (name) => {
  const re = new RegExp("const " + name + " = z\\.object\\(\\{([\\s\\S]*?)\\}\\);");
  const m = schema.match(re);
  if (!m) throw new Error("schema block not found: " + name);
  return m[1];
};
const fieldsOf = (name) =>
  [...blockOf(name).matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
const caps = (name) => {
  const f = fieldsOf(name);
  return {
    n: f.length,
    decision: f.includes("permissionDecision"),
    mutateInput: f.includes("updatedInput"),
    context: f.includes("additionalContext"),
    mutateOutput: f.includes("updatedToolOutput") || f.includes("updatedMCPToolOutput"),
  };
};

const pre = fieldsOf("preToolUseSpecific");
const post = fieldsOf("postToolUseSpecific");
console.log("preToolUse fields:", pre.length, "->", pre.join(", "));
console.log("postToolUse fields:", post.length, "->", post.join(", "));
console.log("postToolUse has permissionDecision:", post.includes("permissionDecision"));

// 3. 五个事件的字段能力矩阵
const matrix = {
  PreToolUse: caps("preToolUseSpecific"),
  PostToolUse: caps("postToolUseSpecific"),
  PostToolUseFailure: caps("postToolUseFailureSpecific"),
  UserPromptSubmit: caps("userPromptSubmitSpecific"),
  SessionStart: caps("sessionStartSpecific"),
};
const y = (b) => (b ? "有" : "无");
console.log("");
console.log("事件字段矩阵（字段数/裁决/改参/注上下文/改输出）：");
for (const [k, v] of Object.entries(matrix)) {
  const pad = k.padEnd(19);
  console.log("  " + pad + " " + v.n + "  " + y(v.decision) + " " + y(v.mutateInput) + " " + y(v.context) + " " + y(v.mutateOutput));
}
const onlyPre = Object.entries(matrix).filter(([, v]) => v.decision).map(([k]) => k);
console.log("  -> 带权限裁决的事件:", onlyPre.join(", ") || "(none)");

// 4. 合并优先级：从 aggregator 源码里读出顺序
const agg = read("hookAggregator.ts");
const order = [...agg.matchAll(/effectiveDecision === \x27(\w+)\x27/g)].map((m) => m[1]);
const precedence = [...new Set(order)];
precedence.push("undefined");
console.log("");
console.log("decision priority:", precedence.join(" > "));
console.log("priority comment:", /\/\/ Decision priority: ([^\n]+)/.exec(agg)[1].trim());

// 5. 最弱信号那句注释
const weakest = /\/\/ Weakest signal[^\n]*/.exec(agg);
console.log("weakest signal:", weakest ? weakest[0].trim() : "(missing)");

// 6. fail-closed：system 异常直接 deny
const denyFn = /export function (buildPreToolUseDenyResult)/.exec(agg);
console.log("fail-closed deny fn:", denyFn ? denyFn[1] : "(missing)");

// 7. 事件总数与关键文件行数
const types = read("types.ts");
const enumBody = /export enum HookEventName \{([\s\S]*?)\n\}/.exec(types)[1];
const events = [...enumBody.matchAll(/^\s{2}(\w+) =/gm)].map((m) => m[1]);
console.log("hook events:", events.length);

console.log("");
console.log("关键文件行数：");
for (const f of ["hookOutputSchema.ts", "hookAggregator.ts", "hookPlanner.ts", "types.ts", "hookRunner.ts"]) {
  console.log(String(lines(f)).padStart(6), rel(path.join(HOOKS, f)));
}
