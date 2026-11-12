---
title: "Agent 与 Workflow —— 六种终止模式与四个内置代理"
order: 12
part: "Part C · 上下文与资产"
eyebrow: "Q12"
meta: "1,597 字 · 24 行代码 · 4 块 · 约 13 分钟"
status: sample
snapshot: "1.0.0-preview @ 2026-11-12"
---

Q07 提到 `Agent` 是唯一的代理入口，`explore`、`plan` 只是它的参数。
本章讲这个入口背后的执行模型：
一个子代理怎么启动、怎么终止、五种内置代理各是什么。

## 一、六种终止模式

`AgentTerminateMode`（`packages/core/src/agents/types.ts:57-64`）六项枚举：

```ts
export enum AgentTerminateMode {
  ERROR = 'ERROR',
  TIMEOUT = 'TIMEOUT',
  GOAL = 'GOAL',
  MAX_TURNS = 'MAX_TURNS',
  ABORTED = 'ABORTED',
  ERROR_NO_COMPLETE_TASK_CALL = 'ERROR_NO_COMPLETE_TASK_CALL',
}
```

六个值里，`GOAL` 是唯一「正常完成」的。
其余五个都是异常退出。

`ERROR_NO_COMPLETE_TASK_CALL` 这个最长，也最值得说：
**子代理跑完了，但没有调用 `CompleteTask` 工具。**
也就是说它说了很多话，但没有正式宣布「任务完成」。

为什么要单独分出这一种？因为子代理的返回值要给父代理用。
没有 `CompleteTask` 就没有结构化的输出，父代理拿到的是自由文本——
这跟「出错」不同，是「完成得不符合契约」，需要区别对待。

对比 Q04 讲的 `Terminal.reason` 只有五个值：

| 层级 | 枚举 | 值数 |
| --- | --- | --- |
| 主循环 | `Terminal['reason']` | 5 |
| 子代理 | `AgentTerminateMode` | 7 |

子代理多了 `TIMEOUT` 和 `ERROR_NO_COMPLETE_TASK_CALL`——
因为子代理是被调用方，有超时约束和输出契约。

## 二、两套回合上限

`types.ts` 里有两个回合常量，相差 6 倍多：

```ts
export const DEFAULT_LOCAL_SUBAGENT_MAX_TURNS = 150;

/**
 * @deprecated Retained only for backward compatibility with external consumers.
 * Built-in agents no longer use these defaults — undefined means "no limit".
 */
export const DEFAULT_MAX_TURNS = 1000;
```

`DEFAULT_LOCAL_SUBAGENT_MAX_TURNS` 是 150，用于普通本地子代理；
`DEFAULT_MAX_TURNS` 是 1000，已标 `@deprecated`。

注释里那句很关键：**built-in agents 现在用「无限制」作为默认**。
也就是说内置代理不传 `maxTurns` 就是不设上限，
1000 只是给外部消费者留的兼容值。

从「有一个大默认值」到「默认无限制」，这个转变说明：
回合数不是防失控的主要手段，`GOAL` 与 `ABORTED` 才是。

## 三、四个内置代理

`agents/builtin/` 目录下四个代理定义 + 一份共享提示词：

| 文件 | 代理 | 特点 |
| --- | --- | --- |
| `explore-agent.ts` | explore | 只读探索 |
| `plan-agent.ts` | plan | 出方案不执行 |
| `general-purpose-agent.ts` | general-purpose | 通用 |
| `statusline-setup-agent.ts` | statusline-setup | 状态栏配置 |
| `read-only-agent-prompt.ts` | —— | 只读提示词共享 |

`read-only-agent-prompt.ts` 是共享模块而不是代理本身，
说明 explore 和 plan 共用同一套「只读约束」提示词。
这种提取避免了两个代理的约束逐渐漂移。

Q07 讲过 `READ_ONLY_SUBAGENT_DISALLOWED_TOOLS` 这个常量（`tools/tool-names.ts:372`），
它和这份提示词是一对：**提示词说「不要写」，工具表里直接不给写工具**。
两道防线，提示词层和工具层各一道。


## 四、Agent 工具的预检

`AgentTool`（`packages/core/src/agents/subagent-tool.ts:512`，2,242 行）
是整个 agents 目录里最大的文件。它有一个私有方法叫 `getPreflightRefusal`（`:853`）：

「预检拒绝」——**在启动子代理之前就先拒绝**。

为什么要预检？因为启动子代理很贵：
要建会话、装配提示词、申请模型配额。
如果参数明显不对，应该在花这些成本之前就拒绝。

`getUnavailableAgentTypes`（`:807`）返回不可用的代理类型集合，
两个来源：

1. **显式禁用** —— `disableAgentType`（`:661`）注册的；
2. **能力不足** —— `_buildExcludedTypesSet`（`:778`）按当前模式算出来的。

第二个值得说。比如只读模式下，`general-purpose` 代理可能不可用——
因为它要写文件。这时不是启动后再拦，而是根本不出现在可选列表里。

## 五、子代理与主循环的四个差别

子代理不是「另一个 `query()` 调用」那么简单。四处关键差别：

| 维度 | 主循环 | 子代理 |
| --- | --- | --- |
| 终止原因 | `Terminal.reason`（5 值） | `AgentTerminateMode`（7 值） |
| 回合上限 | 无默认上限 | 150（本地）/ 无限制（内置） |
| 输出契约 | 自由文本 | 需 `CompleteTask` 结构化 |
| 事件流 | `query.*` 总线 | `subagent-sdk-events` 投影 |

第四行对应 `subagent-sdk-events.ts`（384 行）。
子代理的事件要投影成 SDK 格式给外部消费者——
所以有两套事件模型：内部总线与对外投影。

这个双层结构在 Q03 讲过：总线的 `query.output` 里装的是 `QueryEvent`，
对外出口再做一次投影。子代理只是多了一层 `subagent` 前缀的投影。

## 六、团队模式

`agents/teams/` 目录下有四个文件，处理多代理协作：

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `agent-team-tools.ts` | 1,141 | 团队工具 |
| `agent-team-runtime.ts` | 781 | 团队运行时 |
| `agent-team-wakeup.ts` | 317 | 唤醒机制 |
| `agent-team-hook-coordinator.ts` | 278 | 钩子协调 |

`agent-team-wakeup.ts` 说明团队不是「并行跑完就结束」——
代理之间可以互相唤醒。这跟 Q07 讲的 `SendMessage` / `ListAgents` 工具对应。

`agent-team-hook-coordinator.ts` 则是把钩子系统（Q08）接入团队场景：
一个代理触发的事件，可能影响整个团队的判定。

## 七、工程暗坑

**1. `ERROR_NO_COMPLETE_TASK_CALL` 不能当成功处理**
子代理跑完但没调 `CompleteTask`，父代理拿到的是自由文本。
如果当成功，父代理会基于不可靠的输出继续推理。
必须区分「完成且合规」与「完成但不合规」。

**2. 预检必须在启动之前**
`getPreflightRefusal` 的命名就说明了时机。
放在启动之后，就白花了会话与配额成本。

**3. 内置代理的「无限制」是新默认**
`DEFAULT_MAX_TURNS` 已 `@deprecated`。
新代码不要依赖 1000 这个值存在——它可能被删除。

**4. 只读代理有两道防线**
提示词（`read-only-agent-prompt.ts`）+ 工具表（`READ_ONLY_SUBAGENT_DISALLOWED_TOOLS`）。
只做提示词层等于没做——模型可以不听话，但工具表里没有写工具就真的写不了。

**5. 事件投影不能复用主循环的格式**
`subagent-sdk-events.ts` 独立存在，说明子代理的事件语义与主循环不同。
强行复用会让外部消费者分不清「这是主代理还是子代理的事件」。

## 八、本章源码索引

| 文件 | 行数 | 本章用到的位置 |
| --- | --- | --- |
| `packages/core/src/agents/types.ts` | 442 | `:57-64` 六种终止模式 |
| | | `:75-81` 两套回合上限 |
| `packages/core/src/agents/subagent-tool.ts` | 2,242 | `:512` AgentTool
| | | `:661-669` 禁用代理，`:807-` 不可用集合，`:853-` 预检拒绝 |
| `packages/core/src/agents/run-agent.ts` | 1,893 | 代理执行主流程 |
| `packages/core/src/agents/run-subagent.ts` | 677 | 子代理执行 |
| `packages/core/src/agents/fork-subagent.ts` | 231 | fork 子代理 |
| `packages/core/src/agents/registry/agentRegistry.ts` | 1,013 | 代理注册表 |
| `packages/core/src/agents/registry/agentLoader.ts` | 627 | 代理加载 |
| `packages/core/src/agents/builtin/explore-agent.ts` | 197 | explore 代理 |
| `packages/core/src/agents/subagent-sdk-events.ts` | 384 | 对外事件投影 |
| `packages/core/src/agents/teams/agent-team-runtime.ts` | 781 | 团队运行时 |

## 九、自己动手验证

```bash
node qw-examples/check/12-agents.mjs
```

预期输出：
```text
terminate modes: 6
builtin agents: 4
turn defaults: 2
agent tool methods: 52
  442 agents/types.ts
 2242 agents/subagent-tool.ts
 1893 agents/run-agent.ts
 1013 agents/registry/agentRegistry.ts
```

改一处试试：把 `AgentTerminateMode.ERROR_NO_COMPLETE_TASK_CALL`
合并进 `ERROR`，然后让一个子代理只说「我做完了」但不调 `CompleteTask`。
父代理会收到一个普通的错误，然后选择重试——
但重试的结果还是同样的自由文本，形成循环。
单独分出这个模式，就是为了让父代理知道「该换个提示词」，而不是「再试一次」。

## 十、下一步

Part C 到此结束。三章讲完了「模型看到什么、装不下怎么压、资产怎么挂」。
Part D 转向使用侧：
Q13 讲 ACP 与 headless——怎样把内核接进编辑器与脚本；
Q14 讲 TUI——`ink` 那一层怎么渲染。

---

> **本章读完你应该能回答**：
> ① 子代理有几种终止模式？哪种是正常完成？
>    ——六种；只有 `GOAL` 是正常完成。
> ② `ERROR_NO_COMPLETE_TASK_CALL` 为什么不并进 `ERROR`？
>    ——它是「完成但不合规」，处理方式不同（换提示词而非重试）。
> ③ 为什么要有预检拒绝？
>    ——启动子代理成本高，参数错误应该在花钱前拦下。
> ④ 只读代理为什么要两道防线？
>    ——提示词可能不被遵守，工具表里没有写工具才是硬约束。
> ⑤ `DEFAULT_MAX_TURNS` 为什么标废弃？
>    ——内置代理改为默认无限制，依赖固定值会失效。
