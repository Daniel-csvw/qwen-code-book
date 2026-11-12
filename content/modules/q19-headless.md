---
title: "实战五：headless 流水线"
order: 19
part: "Part E · 实战拓展"
eyebrow: "Q19"
meta: "2,139 字 · 93 行代码 · 12 块 · 约 16 分钟"
status: sample
snapshot: "1.0.0-preview @ 2026-11-12"
---

Q13 讲过 7 个 FrameworkMode，headless 与 ACP、TUI 并列。
本章不再是「读代码」，而是**把它接进 CI**：
让工具、钩子、技能、MCP 服务器在无人值守时也能跑。

## 一、headless 是自动判定的，不是配出来的

很多人以为要加 `--headless`。没有这个标志。
判定在 `isHeadlessMode`（`packages/core/src/utils/headless.ts:45-77`），四条触发条件：

| 条件 | 判据 |
| --- | --- |
| CI 环境 | `process.env.CI === 'true'` 或 `GITHUB_ACTIONS === 'true'` |
| 非 TTY | stdin 或 stdout 任一不是 TTY |
| 显式 prompt | `--prompt` / `-p` 存在 |
| SDK 模式 | `--input-format stream-json` 或 `--print` |

**「非 TTY」是其中最容易被忽略的一条**。在 CI 里管道重定向了 stdout，
`process.stdout.isTTY` 就是 `undefined`，于是自动进 headless——
你甚至不用传任何标志。

这也解释了一个常见困惑：「本地能交互，进 CI 变成一次性执行」。
不是你配错了，是 TTY 没了。

`:46-52` 还有个反例开关：

```ts
if (readBrandEnv(ENV_INTEGRATION_TEST) !== 'true') {
  const isCI =
    process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true';
  if (isCI) {
    return true;
  }
}
```

集成测试可以设一个环境变量，**让 CI 检测失效**。
否则测试在流水线里跑，永远拿不到交互模式，一半用例写不出来。

## 二、两条输入路径

进去之后分两条路（`packages/cli/src/headless/headlessSession.ts:199-203`）：

```ts
if (this.streamJsonInput) {
  await this.runStreamJsonInput();
} else {
  await this.runTextTurn();
}
```

**text 路径**：读一次性 prompt，跑一轮，把最终结果打到 stdout。
适合「跑完就走」的 CI 任务。

**stream-json 路径**：从 stdin 流式读多条用户消息，每条都跑，
结果按帧（frame）逐条写到 stdout。适合**长会话**：
你可以在一个进程里连续问十个问题，不用每次重启（省掉冷启动和上下文重建）。

**输入**两条路，**输出**三条（`--output-format`，见 `commands/index.ts:419`）：
`text`（纯文本）、`json`（单个 JSON 对象）、`stream-json`（逐帧流）。
输入 `stream-json` 必须配输出 `stream-json`，否则启动就报参数错误——
因为流式输入需要帧级回执，纯文本无法承载。

路由标签也据此区分（`packages/cli/src/startup/options/headless.ts:28-33`）：
`headlessStreamJson` 与 `headlessText`。两个标签在监控里是分开统计的。

## 三、退出码：CI 唯一能听懂的语言

CI 不读你的漂亮输出，它只看退出码。
headless 的退出码规则写在 `nonInteractiveOutput.ts:63-106`：

```ts
export function getHeadlessResultExitCode(msg: SDKMessage): number | undefined {
  if (msg.type !== 'result') {
    return undefined;
  }
  return msg.is_error ? 1 : 0;
}
```

再看中断的处理（`:78-81`）：

```ts
} else if (msg.type === 'result' && msg.subtype !== 'success') {
  const errorMsg = extractResultErrors(msg);
  process.exitCode = errorMsg.includes('Operation aborted') ? 130 : 1;
}
```

三条规则：

| 情形 | 退出码 |
| --- | --- |
| `result.is_error === true` | 1 |
| 被中断（`Operation aborted`） | 130 |
| 其它非 success 子类型 | 1 |
| 正常 | 0 |

**130 是 shell 的惯例值**（128 + SIGINT=2）。流水线看到 130 就知道
「有人按了取消」，不是代码有问题；看到 1 才是真失败。
把两者混成一个 1，会让「取消」在报表里显示成「失败」，
排查时白找半天。

text 路径还有三种子类型的分支（`:88-105`）：
`success`、`error_during_execution`、`error_max_turns`。
最后一条尤其重要——**回合数用尽也算失败**。
Q12 讲过子代理有回合上限；主会话在 headless 下同理，
跑到上限就 `exit 1`，不会假装成功。

## 四、没人能点「允许」时，权限怎么办

这是 headless 最实际的问题。TUI 里弹个窗，你点一下就行；
CI 里没人。源码给了四种模式（`packages/cli/src/utils/headlessPermissionPrompt.ts`）：

| 模式 | 触发条件 | 谁来回答 |
| --- | --- | --- |
| stdio 提示 | `--permission-prompt-tool stdio` | 通过 stdio 问宿主进程 |
| 具名工具 | 传了其它工具名 | 用那个 MCP 工具去问 |
| 默认 | `--input-format stream-json` 且未指定 | 走 stdio |
| 远程 worker | 远程 worker 模式 | 交给远端控制器 |

优先次序在 `:32-40`：

```ts
const isStdio = isStdioPermissionPromptTool(permissionPromptTool);
const isNamedPermissionPromptTool =
  Boolean(permissionPromptTool) && !isStdio;
const namedPermissionPromptTool = isNamedPermissionPromptTool
  ? permissionPromptTool
  : undefined;
const useStdioPermissionPrompt =
  isStdio ||
  (!isNamedPermissionPromptTool && inputFormat === 'stream-json');
```

注意 `stdio` 这个值是**特例**：它是唯一被硬编码的名字，
其余任何字符串都当「工具名」。所以别给工具起名叫 `stdio`。

`:47-48` 那句注释解释了一个容易踩的坑：

```ts
// SDK 仅在配置 canUseTool 时显式传入 stdio；未配置时由权限 Hook 决策。
installStdioPermissionHandler:
  useStdioPermissionPrompt && (!isSDKMode() || isStdio),
```

SDK 模式下，如果宿主没配 `canUseTool` 回调，**不安装** stdio 处理器。
否则一个没人接的权限请求会挂在那儿，等到超时才结束。
让权限 Hook 去决策（Q16 写的那种），至少能立刻给出 `deny`。

**实践建议**：CI 里最省事的做法不是去实现权限协议，
而是**在配置里把「允许什么」写清楚**：
- 用 `--permission-mode` 选一个预置模式
- 或用 Q08 的规则文件，白名单精确到命令
- 或给 MCP 服务器加 `trust: true`（Q18 讲过）

## 五、异常收敛：一条流不能断在半截

stream-json 的消费者（你的脚本）在逐行解析 stdout。
如果进程中途抛出未捕获异常，输出就断在半个 JSON 上——
解析器直接崩，你连错误信息都拿不到。

所以 `run()` 有一段专门处理这件事（`headlessSession.ts:204-217`）：

```ts
} catch (error) {
  if (error instanceof HeadlessStartupAbort) {
    this.renderStartupFailure(error.failure);
  } else if (
    this.streamJsonOutput &&
    this.openedSessionId &&
    !(error instanceof FatalError)
  ) {
    // stream-json 的会话级意外失败以单帧 result 收尾；text 与 FatalError
    // 仍走入口的错误出口（stderr + 对应退出码）。
    this.renderSessionFailure(error);
  } else {
    throw error;
  }
} finally {
  this.permissionChannel?.close();
```

四个条件同时成立才「收敛成 result 帧」：
用了 stream-json 输出、会话已打开、且不是致命错误。
**会话没打开**就不收敛——因为这时还没有流可断，直接抛出去更清楚。

`finally` 里三件事也值得看：关权限通道、移除 stdout 错误处理、
`finish()` 里清工具失败日志。清日志是为了**不跨会话泄漏**——
长驻进程跑十条消息，第九条的失败不该出现在第十条的报告里。

## 六、把前面四章接起来：一条真实的 CI 流水线

到这一步，我们手上的东西可以拼成一条完整的审查流水线了。

**`.qwen/settings.json`**（权限白名单）：

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Bash(npm test:*)",
      "Bash(git diff:*)"
    ],
    "deny": ["Bash(git push:*)", "Bash(rm:*)"]
  }
}
```

**`.qwen/skills/review/SKILL.md`**（Q17 写的技能，改一版做审查）：

```markdown
---
name: review
description: Review staged changes for bugs and style issues.
allowed-tools: Read, Bash
---

审查 `git diff --staged` 的内容。

1. 读 diff，逐文件列出改动意图
2. 找逻辑错误、边界条件、未处理的错误路径
3. 输出 Markdown 表格：文件 | 问题 | 严重度

只报告真实问题，不要凑数。
```

**CI 脚本**：

```bash
#!/usr/bin/env bash
set -uo pipefail

qwen --prompt "/review" --output-format text > review.md
code=$?

case $code in
  0)   echo "review ok" ;;
  130) echo "cancelled"; exit 0 ;;
  *)   echo "review failed (exit $code)"; exit $code ;;
esac
```

三个细节：

1. **`set -e` 换成 `set -uo pipefail`**。要自己读 `$?`，就不能让 `set -e`
   在赋值前把脚本干掉。
2. **130 当作成功**。取消不是失败，别让报表变红。
3. **`--output-format text`** 拿到的是纯文本结果，写 `> review.md` 直接成文件；
   要结构化就换 `json`（单次结果）或 `stream-json`（逐帧）。

## 七、工程暗坑

**1. 没有权限通道时会降级成 `isPlainHeadless`**
源码在 `config.ts:1343-1347` 判定：非交互且无外部权限处理器时，
隐藏交互类工具、关掉 Plan 模式（`isPlanModeRequest(...) && !isPlainHeadless`，`:1355`）。
所以在 CI 里**配置不全等于一批能力直接消失**，而不是「等着人点」。

**2. stdout 只能有协议数据**
`installStdoutErrorHandler` 在 `run()` 里很早就装上了（`:190`）。
任何 `console.log` 都会污染流——包括你加的调试输出。
调试信息一律走 stderr。

**3. 回合上限会静默截断长任务**
`error_max_turns` 是真实存在的失败子类型。
一个大重构如果预计要 40 轮，就得把上限调上去，
否则跑一半退出、退出码 1，看起来像「代码有问题」。

**4. 超时是外部的责任**
headless 自己不设总时长上限。CI 平台通常有 job timeout，
但那会杀掉进程、拿不到 result 帧。
更稳的做法是在脚本里用 `timeout 600 qwen ...`，
让它先收到中断、走 130 那条路。

**5. 非 TTY 下颜色码可能混进输出**
即使不用 `--output-format`，某些库会检测到「不是 TTY」而跳过颜色。
但如果检测写错，ANSI 码就混进 `review.md`。
看到文件里有一堆 `[32m`，就是这个问题。

## 八、本章源码索引

| 文件 | 行数 | 本章用到的位置 |
| --- | --- | --- |
| `packages/core/src/utils/headless.ts` | 100 | `:45-77` 四条触发条件 |
| | | `:46-52` 集成测试豁免 |
| `packages/cli/src/startup/options/headless.ts` | 42 | `:28-33` 两条路由标签 |
| `packages/cli/src/headless/headlessSession.ts` | 954 | `:183-229` `run()` 主流程 |
| | | `:199-203` 两条输入路径 |
| | | `:204-227` 异常收敛与清理 |
| `packages/cli/src/utils/nonInteractiveOutput.ts` | 273 | `:63-68` 退出码 |
| | | `:74-82` 中断 130 |
| | | `:84-106` 三种子类型 |
| `packages/cli/src/utils/headlessPermissionPrompt.ts` | 54 | `:28-53` 四种权限模式 |
| `packages/cli/src/nonInteractiveCliCommands.ts` | 351 | 斜杠命令在 headless 下的服务化 |
| `packages/core/src/engine/headless-projection.ts` | 923 | 会话事件投影成 SDK 消息 |

## 九、自己动手验证

```bash
node qw-examples/check/19-headless.mjs
```

预期输出：
```text
headless triggers: 4 -> CI env | not TTY | prompt flag | stream-json
also accepts -p: true
GITHUB_ACTIONS env: true
headless routes: 2 -> headlessStreamJson / headlessText
exit code: is_error -> 1: true
exit code: aborted -> 130: true
text result subtypes handled: success, error_during_execution, error_max_turns
permission prompt modes: 4 -> stdio | named tool | stream-json→stdio |
  remote worker
```

改一处试试：注释掉 `headless.ts:58` 里的 `!!options?.prompt`，
然后用 `qwen -p "hi"` 在一个真终端里跑。

你会看到它**没有**进 headless——因为 TTY 还在，
而唯一的触发条件被你关了。光标悬在那里等交互输入。
这个实验直接证明：headless 是「环境推断」出来的，不是一个开关。

## 十、全书收尾

到这里，19 章全部走完。回头看这条路线：

- **Part A** 给了你一张地图（Q01–Q02）
- **Part B** 拆开了内核：事件总线、对话回合、请求装配、消息协议、工具、权限
- **Part C** 讲了上下文怎么攒起来又怎么压下去，技能与子代理怎么复用
- **Part D** 说清楚了三种前端（ACP、headless、TUI）如何共用一套内核
- **Part E** 是你亲手写的五个东西：工具、钩子、技能、MCP 服务器、CI 流水线

如果只记三句话：

1. **一切皆事件**。`query()` 只有一个输入口，其余全是事件进出。
2. **确定性换可靠性**。参数替换不用模型、工具 ID 重写保持稳定、
   MCP 键名反向映射——凡是能用字符串干的事，都不交给模型。
3. **失败要显式**。`POLICY_VIOLATION` 不重试、130 不等于 1、
   幽灵 required 剪掉要打 warn——**能看见的失败，才是能修的失败**。

附录 A 是一份「按问题查」的索引，附录 B 列了全书引用的源码坐标。
之后你该去读真正的源码了——这本书只是带你走到门口。

---

> **本章读完你应该能回答**：
> ① headless 是谁判定的，能主动关掉吗？
>    ——`isHeadlessMode()` 按环境推断，CI 与 TTY 两条最常触发；
>    集成测试可用环境变量豁免。
> ② 退出码 130 和 1 有什么区别？
>    ——130 是被中断（128+SIGINT），1 是真失败。
> ③ `--output-format` 有几个取值？
>    ——三个：`text`、`json`、`stream-json`。
> ④ stream-json 模式下进程崩溃会发生什么？
>    ——会话已打开时会收敛成一帧 `result` 收尾，不让流断在半截。
> ⑤ 没有权限协议实现时会怎样？
>    ——进入 `isPlainHeadless`：隐藏交互工具、禁用 Plan 模式
>    （`config.ts:1343-1347`），因为没有「人」可以做批准。
