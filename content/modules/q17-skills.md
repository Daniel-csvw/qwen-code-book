---
title: "实战三：写一个技能——发版一条龙"
order: 17
part: "Part E · 实战拓展"
eyebrow: "Q17"
meta: "1,965 字 · 100 行代码 · 13 块 · 约 16 分钟"
status: sample
snapshot: "1.0.0-preview @ 2026-11-12"
---

Q11 讲过技能的内部机制：14 个内置技能、`prepareSkillBody` 的两条路、
shell 注入的五个防护点。但没有写过一个自己的。
本章写一个：**收版本号 → 跑测试 → 生成变更摘要**，一条发版流水线。

## 一、技能就是一个带 frontmatter 的 Markdown

先看一个真的。仓库里 `skill-creator` 这个内置技能的头部
（`packages/core/src/skills/builtin/skill-creator/SKILL.md:1-8`）：

```markdown
---
name: skill-creator
description:
  Guide for creating effective skills. This skill should be used when users want
  to create a new skill (or update an existing skill) that extends the CLI's
  capabilities with specialized knowledge, workflows, or tool integrations.
allowed-tools: Edit, Write
---

# Skill Creator for Qwen Code
```

三个字段：`name`、`description`、`allowed-tools`。
`description` 用了 YAML 的折叠写法（下一行缩进续写），因为一句话讲不清。

这三个字段是**必须**的那部分吗？不是。它们只是最常写的三个。

## 二、frontmatter 到底认哪些字段

`ParsedFrontmatter` 定义了技能的完整契约
（`packages/resource/src/resource/kinds/skills/types.ts:58-74`）：

```ts
export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  model?: string;
  allowedTools?: string[];
  whenToUse?: string;
  argumentHint?: string;
  arguments?: SkillArgument[];
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  effort?: EffortValue;
  context?: 'fork';
  agent?: string;
  hooks?: Record<string, unknown>;
  paths?: string[];
  shell?: FrontmatterShell;
}
```

**15 个字段，全部可选**。一个只有正文、没有 frontmatter 的 `SKILL.md`
也能被加载——它只是拿不到名字，只能用目录名。

按用途分四组：**身份**（`name` `description` `whenToUse`）、
**参数**（`arguments` `argumentHint`）、
**开关**（`disableModelInvocation` `userInvocable`）、
**执行**（`model` `effort` `context` `agent` `hooks` `paths` `shell`）。

注意 YAML 里的键写法与代码字段名不同：YAML 用 `allowed-tools`，
代码字段叫 `allowedTools`。这个映射发生在 `extractExtendedFields` 里，而且是**逐字段手写**的。

## 三、键名的三种写法，只认其中几种

这是最容易被 json-schema 思维带偏的地方。
`extractExtendedFields` 每读一个字段，就手写一遍候选键名（`:118-126`）：

```ts
const parsedTools = parseSlashCommandToolsFromFrontmatter(
  obj['allowed-tools'] ?? obj['allowed_tools'],
);

const whenToUse =
  obj['when-to-use'] ?? obj['when_to_use'] ?? obj['whenToUse'];
```

`whenToUse` 接受**横线、下划线、驼峰三种拼法**，
而 `allowed-tools` **只接受横线和下划线两种**，没有驼峰。
所以 `allowedTools: Edit, Write` 会**静默失效**：技能照常加载，
但工具白名单是空的，等于不限制。
同样的不对称还有 `disable-model-invocation`（`:163-164`，也只有两种拼法）：

```ts
const disableModelInvocation =
  obj['disable-model-invocation'] ?? obj['disable_model_invocation'];
```

它同样没有驼峰兜底。写错的结果是安全语义反了却不报错：
你本意是「只允许手动调起」，实际却能被模型调起。

**结论**：键名以源码为准，别凭 TypeScript 字段名反推；
统一用横线写法最稳。

## 四、写我们的技能：发版一条龙

目录结构：

```text
.qwen/skills/release/
└── SKILL.md
```

`.qwen/skills/` 是这个 CLI 的固定约定目录。
`discoverSkillDirs.ts:67` 会在目录树里逐级向上找 `<dir>/.qwen/skills/`，
所以放在哪一层都能被发现，但**离代码越近的优先**。

`SKILL.md` 内容：

```markdown
---
name: release
description:
  Cut a release: read the version, run the test suite, and draft a changelog
  entry. Use when the user says "发版", "release", or "准备发布".
when-to-use: 用户要求发版、准备发布、生成版本摘要时
argument-hint: "[patch|minor|major]"
arguments:
  - name: bump
    description: 版本级别 patch/minor/major
    required: false
allowed-tools: Read, Bash, Edit
---

# 发版一条龙

版本级别：$bump（默认 patch）

## 步骤

1. 读 `package.json` 的 `version` 字段
2. 按 `$bump` 计算新版本号
3. 运行 `npm test`，失败则停止并汇报
4. 从 `git log --oneline $(git describe --tags)..HEAD` 收集变更
5. 按 Keep a Changelog 格式生成条目
6. 改 `package.json` 与 `CHANGELOG.md`，不要提交

## 约束

- 测试失败必须停下，不要"先改版本再说"
- 不执行 `git commit` / `git push`
```

六个字段，各自的作用在下一节拆。

## 五、参数怎么进正文：四层替换

技能正文里的 `$bump` 不是模型猜出来的。14 行注释把这一点说得很硬
（`packages/core/src/skills/inlineSkillActivation.ts:14-15`）：

```ts
 * Arguments are always passed as function parameters, never through model
 * inference.
```

「参数永远作为函数参数传入，绝不经过模型推理」。
这意味着 `$bump` 的替换是**确定性的字符串操作**，没有不确定性。

替换发生在 `substituteArguments`（
`packages/core/src/utils/argumentSubstitution.ts:101-152`），**顺序敏感的四步**：

| 序 | 行 | 匹配 | 替换成 |
| --- | --- | --- | --- |
| 1 | `:124` | `$name`（具名） | `parsedArgs[i]` |
| 2 | `:131` | `$ARGUMENTS[n]` | `parsedArgs[n]` |
| 3 | `:137` | `$0` `$1`（简写） | `parsedArgs[n]` |
| 4 | `:143` | `$ARGUMENTS`（全量） | 原始参数字符串 |

**第 4 步必须最后**。因为 `$ARGUMENTS` 是 `$ARGUMENTS[0]` 的前缀，
如果先做全量替换，`$ARGUMENTS[0]` 会被拆成「参数串 + 字面量 `[0]`」。
源码把 `replaceAll('$ARGUMENTS', args)` 排在最后一行（`:143`），正是这个原因。

前三步用 `replace(/正则/g)`，第四步用 `replaceAll`——
后者是纯字面量匹配，不会碰 `$ARGUMENTS` 以外的任何东西。

还有个细节值得注意（`:147-149`）：

```ts
if (content === originalContent && appendIfNoPlaceholder && args) {
  content = content + `\n\nARGUMENTS: ${args}`;
}
```

**如果正文里一个占位符都没有，参数会被追加到末尾**，
格式是 `\n\nARGUMENTS: <原始参数>`。
这个兜底避免了「用户输了参数但技能假装没看见」。

所以我们的技能正文写 `$bump`。
用户在斜杠命令里输 `/release minor`，正文就变成「版本级别：minor」。
如果正文里没写 `$bump`，就会在文末多出一行 `ARGUMENTS: minor`。

斜杠命令与技能是同一份东西：`SkillCommandLoader` 把每个可显示技能
直接映射成斜杠命令，**命令名就是 `skill.name`**，并带上 `autoExecute: true`
（`packages/cli/src/services/SkillCommandLoader.ts:46-59`）。
`autoExecute: true` 意味着回车即执行，不再让模型确认一次；
`argNames` 则让输入框渐进提示剩余参数。
所以 `arguments` 不只影响正文替换，还影响补全 UI。

## 六、正文里还能写什么

除了参数，`substituteSkillBody`（`:173-209`）还会替换环境变量：

```ts
result = result.replaceAll('${' + ENV_SKILL_DIR + '}', () => opts.skillDir);
result = result.replaceAll(
  '${' + ENV_SKILL_SESSION_ID + '}',
  () => opts.sessionId,
);
```

`${SKILL_DIR}` 是技能自己的目录，`${SKILL_SESSION_ID}` 是当前会话 ID。
用箭头函数包一层而不是直接传值，是防替换值里的 `$&` 被当成替换模式。

Q11 那个点要重申：**`${SKILL_DIR}` 只是路径信息，不是权限授予**。
`buildSkillPromptContent` 的注释写得很明确（`:221-223`）：

```ts
/**
 * Builds the model-visible prompt for a skill. A filesystem-backed skill's
 * base directory is resource-location metadata, not a filesystem permission
 * grant. Built-in skills are programmatic and have no resource root to expose.
 */
```

「我的文件在这个目录」不等于「你有权访问」，权限还是走 Q08 那套判定。

## 七、激活时的四道闸

技能被调起时，`activateSkill` 会依次过四道检查
（`packages/core/src/tools/activate-skill.ts`）：

| 闸 | 行 | 拦什么 |
| --- | --- | --- |
| 存在性 | `:371` | 技能不存在 → 返回候选列表 |
| 禁用 | `:406` | `skill.disabled` → `POLICY_VIOLATION` |
| 模型调用 | `:419` | `disableModelInvocation` → `POLICY_VIOLATION` |
| 分叉 | `:432` | `context === 'fork'` → 走子代理执行 |

后三道里，禁用与 `disable-model-invocation` 都返回 `ToolErrorType.POLICY_VIOLATION`，
不是普通错误——策略违规不该触发重试，重试一万次也还是违规。

`:371-375` 那段注释也很讲究：**只建议这个调用方真能激活的技能**。
否则模型试一个撞一个，一轮对话全在撞墙。
`context: 'fork'` 则把技能丢进隔离子代理执行，工具集由 `agent` 字段决定。
发版技能适合用 fork——它要跑 `npm test`，耗时且脏。

## 八、工程暗坑

**1. 布尔字段是「严格真」**
`parseBooleanFrontmatter`（`frontmatterParsers.ts:103-109`）只认两种输入：

```ts
export function parseBooleanFrontmatter(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string' && value.toLowerCase().trim() === 'true') {
    return true;
  }
  return false;
}
```

YAML 的 `yes`、`on`、`1` 全被当成 `false`。
在 YAML 1.1 里 `yes` 就是合法的布尔真值，
但这里走的是「读原始值再自己判」，不吃 YAML 的宽松惯例。
写 `disable-model-invocation: yes` 的后果是：**这个开关等于没开**。
**2. `allowed-tools` 不写 ≠ 无工具**
不写 `allowed-tools`，技能执行时就继承父级的工具集。
写了才是白名单。这两个语义完全相反，
「想限制但忘了写」和「想放行但写了空」都会出问题。

**3. 没有正文字数限制，但有上下文代价**
技能正文会被整段注入成一条 user 消息。
`skill-creator` 的 `SKILL.md` 有 296 行，这在技能里算长的。
Q10 讲过 `prompt_too_long` 是压缩的 14 种失败之一——
技能正文是它的主要贡献者之一。

**4. YAML 解析失败会静默降级**
`parseFrontmatter`（`skillLoader.ts:56-105`）是三级兜底：
标准 YAML → `repairYamlFrontmatter` 修复 → `parseSimpleFrontmatter` 简单解析。
最后一级只认 `name` 与 `description` 这种单行键值，
`arguments` 这种嵌套结构全部丢失。
而且只记一条 `severity: 'warning'`（`:100`），不阻断加载。
所以「技能能用但参数不生效」时，先去看有没有 warning。

**5. `shell` 字段只有两个取值**
`FRONTMATTER_SHELLS`（`:51`）就是 `['bash', 'powershell']`。
写别的值会回落成 `bash` 并打一条 warn（`:219`）。
在 Windows 上写 `shell: cmd` 不会让你用 cmd，只会让你用 bash。

**6. 技能目录的发现是「向上走」**
`discoverSkillDirs.ts:39-43` 的注释描述了这套 walk-up：
从被访问文件的父目录一路向上，到 `cwd` 之前（不含），
逐级检查 `<dir>/.qwen/skills/`。
所以同一个技能名可以存在于多个层级，**深的赢**。
调试「为什么我的改动没生效」时，先确认有没有更深的同名技能盖住了。
## 九、本章源码索引

| 文件 | 行数 | 本章用到的位置 |
| --- | --- | --- |
| `packages/resource/src/resource/kinds/skills/types.ts` | 83 | `:58-74` 15 个字段 |
| `packages/resource/src/resource/kinds/skills/skillLoader.ts` | 898 | `:51` 两种 shell |
| | | `:56-105` 三级解析兜底 |
| | | `:118-126` 键名候选表 |
| `packages/resource/src/resource/kinds/skills/frontmatterParsers.ts` | 109 | `:103-109` 严格布尔 |
| `packages/core/src/utils/argumentSubstitution.ts` | 209 | `:101-152` 四层替换 |
| | | `:173-209` 环境变量替换 |
| `packages/core/src/skills/inlineSkillActivation.ts` | 440 | `:170-218` 两条正文路径 |
| | | `:221-234` 基目录不是权限 |
| `packages/core/src/tools/activate-skill.ts` | 721 | `:371` 存在性 |
| | | `:406` `:419` `:432` 三道闸 |
| `packages/cli/src/services/SkillCommandLoader.ts` | 150 | `:46-59` 技能转斜杠命令 |

## 十、自己动手验证

```bash
node qw-examples/check/17-skills.mjs
```

预期输出：
```text
frontmatter fields: 15
  -> name, description, model, allowedTools, whenToUse, ...
frontmatter shells: 2 -> bash / powershell
frontmatter parse tiers: 3
substitution steps: 4 -> named $name | indexed $ARGUMENTS[n] | ...
substitution order ascending: true
full $ARGUMENTS is last: true
appends ARGUMENTS when no placeholder: true
activation gates: 3 -> disabled | disable-model-invocation | fork
```

改一处试试：把 `substituteArguments` 里 `replaceAll('$ARGUMENTS', args)`
从 `:143` 挪到 `:130`（`$ARGUMENTS[n]` 之前）。
然后写一个正文含 `$ARGUMENTS[0]` 的技能，传两个参数调起。
你会看到第一段被替换成「整个参数串 + 字面量 `[0]`」——
这就是顺序敏感的直接后果。

## 十一、下一步

工具、钩子、技能都写完了。最后两个拓展点是**重活**：
Q18 写一个 MCP 服务器，让别的进程也能给这个 CLI 供工具；
Q19 把整条链路放进 headless 模式，做成 CI 里能跑的流水线。

---

> **本章读完你应该能回答**：
> ① 技能 frontmatter 有几个字段，必须写的有几个？
>    ——15 个，全部可选。
> ② `allowed-tools` 和 `allowedTools` 都能用吗？
>    ——前者能，后者静默失效；`allowed_tools` 也能。
> ③ `$ARGUMENTS` 为什么必须最后替换？
>    ——它是 `$ARGUMENTS[n]` 的前缀，先换会把后者拆坏。
> ④ `disable-model-invocation: yes` 会生效吗？
>    ——不会，`yes` 被解析成 `false`，只认 `true`。
> ⑤ 技能正文里的 `${SKILL_DIR}` 是权限授予吗？
>    ——不是，只是路径信息，访问权限另走权限系统。
