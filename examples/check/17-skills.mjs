import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
﻿// Q17 验证脚本：技能的 frontmatter 契约与参数替换顺序
// 用法：node qw-examples/check/17-skills.mjs

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const R = (p) => path.join(REPO, p);
const lines = (p) => fs.readFileSync(R(p), "utf8").split(/\r?\n/).length - 1;

const types = fs.readFileSync(R("packages/resource/src/resource/kinds/skills/types.ts"), "utf8");
const fm = /export interface ParsedFrontmatter \{([\s\S]*?)\n\}/.exec(types)[1];
const fields = [...fm.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
console.log("frontmatter fields:", fields.length);
console.log("  ->", fields.join(", "));

const loader = fs.readFileSync(R("packages/resource/src/resource/kinds/skills/skillLoader.ts"), "utf8");
const shellsLine = /const FRONTMATTER_SHELLS[^=]*=\s*\[([^\]]*)\]/.exec(loader)[1];
const shells = shellsLine.split(",").map((s) => s.replace(/[\x27"\s]/g, "")).filter(Boolean);
console.log("frontmatter shells:", shells.length, "->", shells.join(" / "));

// YAML 三级兜底
const tiers = ["load(content)", "repairYamlFrontmatter(content)", "parseSimpleFrontmatter(content)"];
console.log("frontmatter parse tiers:", tiers.filter((t) => loader.includes(t)).length);

// 参数替换的四个正则 + 一次 replaceAll
const sub = fs.readFileSync(R("packages/core/src/utils/argumentSubstitution.ts"), "utf8");
const subst = /export function substituteArguments\(([\s\S]*?)\n\}/.exec(sub)[1];
const stepDefs = [
  ["named $name", "Replace named arguments"],
  ["indexed $ARGUMENTS[n]", "Replace indexed arguments"],
  ["shorthand $n", "Replace shorthand indexed arguments"],
  ["full $ARGUMENTS", "Replace $ARGUMENTS with the full"],
];
const marks = stepDefs.map(([n, marker]) => [n, subst.indexOf(marker)]);
const steps = marks.filter(([, i]) => i >= 0).sort((x, y) => x[1] - y[1]);
console.log("substitution steps:", steps.length, "->", steps.map(([n]) => n).join(" | "));
const ordered = marks.every(([, i]) => i >= 0) && marks.every(([, i], k) => k === 0 || i > marks[k - 1][1]);
console.log("substitution order ascending:", ordered);
// 顺序验证：$ARGUMENTS 的 replaceAll 必须是最后一步
const idxNamed = subst.indexOf("$" + "{name}");
const idxFull = subst.indexOf("replaceAll(\x27$ARGUMENTS\x27");
console.log("full $ARGUMENTS is last:", idxNamed > 0 && idxFull > idxNamed);

// 无占位符时的追加行为
const appendLine = /content = content \+ `\\n\\nARGUMENTS: \$\{args\}`/.test(subst);
console.log("appends ARGUMENTS when no placeholder:", appendLine);

// 激活四道闸
const sk = fs.readFileSync(R("packages/core/src/tools/activate-skill.ts"), "utf8");
const gates = ["skill.disabled", "skill.disableModelInvocation", "skill.context === \x27fork\x27"];
const hit = gates.filter((g) => sk.includes(g));
console.log("activation gates:", hit.length, "->", ["disabled", "disable-model-invocation", "fork"].join(" | "));

// 两套 SKILL.md：内置的有 allowed-tools 横线写法
const skmd = fs.readFileSync(R("packages/core/src/skills/builtin/skill-creator/SKILL.md"), "utf8");
const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skmd)[1];
const keys = [...head.matchAll(/^(\w[\w-]*):/gm)].map((m) => m[1]);
console.log("skill-creator frontmatter keys:", keys.length, "->", keys.join(", "));

console.log("");
console.log("关键文件行数：");
for (const p of [
  "packages/resource/src/resource/kinds/skills/skillLoader.ts",
  "packages/resource/src/resource/kinds/skills/types.ts",
  "packages/core/src/utils/argumentSubstitution.ts",
  "packages/core/src/skills/inlineSkillActivation.ts",
  "packages/core/src/tools/activate-skill.ts",
  "packages/core/src/skills/skillManager.ts",
]) console.log(String(lines(p)).padStart(6), p.replace("packages/", ""));
