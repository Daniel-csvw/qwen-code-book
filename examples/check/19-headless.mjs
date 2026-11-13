import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
﻿// Q19 验证脚本：headless 的判定、退出码与输出格式
// 用法：node qw-examples/check/19-headless.mjs

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const C = (p) => path.join(REPO, "packages/cli/src", p);
const K = (p) => path.join(REPO, "packages/core/src", p);
const read = (p) => fs.readFileSync(p, "utf8");
const linesOf = (p) => read(p).split(/\r?\n/).length - 1;

// 1. headless 判定条件
const hl = read(K("utils/headless.ts"));
const triggers = [
  ["CI env", /process\.env\[\x27CI\x27\] === \x27true\x27/.test(hl)],
  ["not TTY", /isTTY/.test(hl)],
  ["prompt flag", /\-\-prompt/.test(hl)],
  ["stream-json", /inputFormat === \x27stream-json\x27/.test(hl)],
];
console.log("headless triggers:", triggers.filter(([, ok]) => ok).length, "->", triggers.map(([n]) => n).join(" | "));
console.log("also accepts -p:", /\x27-p\x27/.test(hl));
console.log("GITHUB_ACTIONS env:", /GITHUB_ACTIONS/.test(hl));

// 2. 输出格式
const opts = read(C("startup/options/headless.ts"));
const routes = [...opts.matchAll(/headless(StreamJson|Text)/g)].map((m) => "headless" + m[1]);
console.log("headless routes:", new Set(routes).size, "->", [...new Set(routes)].join(" / "));

// 3. 退出码规则（从 nonInteractiveOutput 读）
const out = read(C("utils/nonInteractiveOutput.ts"));
console.log("exit code: is_error -> 1:", /msg\.is_error \? 1 : 0/.test(out));
console.log("exit code: aborted -> 130:", /Operation aborted[\s\S]{0,40}130/.test(out));
const subtypes = [.../case \x27(\w+)\x27/.source ? out.matchAll(/case \x27([a-z_]+)\x27:/g) : []].map((m) => m[1]);
console.log("text result subtypes handled:", subtypes.join(", "));
console.log("writeHeadlessTextResult cases:", (out.match(/case \x27[a-z_]+\x27:/g) || []).length);

// 4. 权限提示模式
const perm = read(C("utils/headlessPermissionPrompt.ts"));
const modes = [
  ["stdio", /isStdioPermissionPromptTool/.test(perm)],
  ["named tool", /isNamedPermissionPromptTool/.test(perm)],
  ["stream-json→stdio", /inputFormat === \x27stream-json\x27/.test(perm)],
  ["remote worker", /isRemoteWorkerMode\(\)/.test(perm)],
];
// 四种模式名较长，按 50 列软折行，避免正文代码块超宽
const modeLine = `permission prompt modes: ${modes.filter(([, ok]) => ok).length} -> ${modes.map(([n]) => n).join(" | ")}`;
console.log(modeLine.length <= 50 ? modeLine : modeLine.slice(0, modeLine.indexOf(" | remote")) + "\n  " + modeLine.slice(modeLine.indexOf("| remote")));

// 5. run() 的结构
const ses = read(C("headless/headlessSession.ts"));
console.log("run() steps:", (ses.match(/^\s+(await )?this\.\w+\(/gm) || []).length);
console.log("has runStreamJsonInput:", /private async runStreamJsonInput/.test(ses));
console.log("has runTextTurn:", /private async runTextTurn/.test(ses));
console.log("session failure as single result frame:", /renderSessionFailure/.test(ses));

console.log("");
console.log("关键文件行数：");
for (const [label, p] of [
  ["core/src/utils/headless.ts", K("utils/headless.ts")],
  ["core/src/engine/headless-projection.ts", K("engine/headless-projection.ts")],
  ["cli/src/startup/options/headless.ts", C("startup/options/headless.ts")],
  ["cli/src/headless/headlessSession.ts", C("headless/headlessSession.ts")],
  ["cli/src/utils/nonInteractiveOutput.ts", C("utils/nonInteractiveOutput.ts")],
  ["cli/src/utils/headlessPermissionPrompt.ts", C("utils/headlessPermissionPrompt.ts")],
  ["cli/src/nonInteractiveCliCommands.ts", C("nonInteractiveCliCommands.ts")],
]) console.log(String(linesOf(p)).padStart(6), label);
