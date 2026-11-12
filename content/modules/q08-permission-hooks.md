---
title: "权限与钩子 —— 两道闸门如何拦住一次工具调用"
order: 8
part: "Part B · 内核"
eyebrow: "Q08"
meta: "1,574 字 · 81 行代码 · 11 块 · 约 16 分钟"
status: sample
snapshot: "1.0.0-preview @ 2026-11-12"
---

Q07 讲了工具怎么注册、怎么调。但「能调」不等于「该调」。

一次工具调用要过两道闸门：

- **钩子**（hooks）——外部脚本可以改输入、可以拦下、可以塞上下文；
- **权限**（permissions）——按模式与规则判定 allow / ask / deny。

两道闸门的顺序、返回值的形状、以及出错时的默认值，
决定了这套 Harness 是不是「安全默认」。

## 一、29 个钩子事件

`HookEventName`（`packages/core/src/hooks/types.ts:41-70`）是一份 29 项枚举。
按阶段分组：

| 阶段 | 事件 |
| --- | --- |
| 会话 | `SessionStart` `SessionEnd` `Setup` `QueryEnd` |
| 提示 | `UserPromptSubmit` `InstructionsLoaded` |
| 工具 | `PreToolUse` `PostToolUse` `PostToolUseFailure` |
| 权限 | `PermissionRequest` `PermissionDenied` |
| 压缩 | `PreCompact` `PostCompact` |
| 代理 | `SubagentStart` `SubagentStop` `TeammateIdle` |
| 任务 | `TaskCreated` `TaskCompleted` |
| 工作区 | `CwdChanged` `FileChanged` |
| 工作树 | `WorktreeCreate` `WorktreeRemove` |
| 交互 | `Elicitation` `ElicitationResult` `Notification` |
| 其它 | `ImagePrepare` `ConfigChange` `Stop` `StopFailure` |

29 个事件不是拍脑袋列的。注意几个成对出现的：

- `PreToolUse` / `PostToolUse` / `PostToolUseFailure` —— 成功与失败分开；
- `PreCompact` / `PostCompact` —— 压缩前后各一次；
- `Elicitation` / `ElicitationResult` —— 提问与回答。

**失败事件单独列出**这件事值得注意。很多 Agent 框架只有「工具执行完」一个钩子，
失败时也走那一条，钩子脚本要自己判断成功与否。
这里拆开，钩子不必再判断。

## 二、五种钩子实现

`HookType`（`:120-125`）只有五个值：

```ts
export enum HookType {
  Command = 'command',
  Runtime = 'runtime',
  Http = 'http',
  Prompt = 'prompt',
  Agent = 'agent',
}
```

这五种的差别不在「什么时候触发」，而在「谁来响应」：

| 类型 | 响应者 | 典型用途 |
| --- | --- | --- |
| `command` | 本地子进程 | shell 脚本检查 |
| `runtime` | 进程内函数 | 内置逻辑 |
| `http` | 远程端点 | 集中式策略服务 |
| `prompt` | 模型 | 用 LLM 判断 |
| `agent` | 子代理 | 复杂判断 |

`prompt` 和 `agent` 这两种意味着：**钩子本身可以调用模型**。
这带来一个递归风险——钩子里再触发钩子。
所以 `hookPlanner.ts`（423 行）要处理「钩子链深度」的问题。

## 三、钩子的七种来源

`ConfigSource`（`:19-27`）七个值，决定钩子配置的优先级：

```ts
export enum ConfigSource {
  Runtime = 'runtime',
  Project = 'project',
  User = 'user',
  Local = 'local',
  System = 'system',
  Plugins = 'plugins',
  Flag = 'flag',
}
```

七层来源，等于七种优先级。这跟权限规则是同一套思路：
**项目级配置可以覆盖用户级，但系统级和命令行的不能被子项目覆盖。**

## 四、权限判定的主循环

`ToolCheck.run()`（`packages/core/src/permissions/manager/tool-check.ts:124-225`）
是权限判定的入口，102 行里有一条清晰的主线：

```ts
const first = await this.runFirstCheck();
if (first.kind !== 'ask') {
  return this.buildDecision(this.request, first, first.kind, 'toolCheck', []);
}
if (this.askHandler === undefined) {
  return this.buildDecision(this.request, first, 'deny', 'ask', []);
}
```

三步：

1. **跑第一次检查** —— allow 或 deny 就直接返回；
2. **是 ask 但没有提问处理器** —— 降级成 **deny**；
3. **有提问处理器** —— 弹给用户，等回答。

第 2 步是关键的安全默认：**无法提问时，一律拒绝**。
反过来如果降级成 allow，「headless 模式 + 有风险工具」就成了绕过权限的口子。

用户批准之后还有一次复查（`:196-215`）：

```ts
// Local edits do not revoke an unchanged manual approval. Managed rules
// are read live by runChecker; amended inputs still use the latest rules.
if (handleResult.input === undefined) snapshot.rules = approvedRules;
// Approval settles the ask. Recheck rules without invoking Auto judges again.
const recheck = await this.runCheckFor(
  approvedRequest,
  snapshot,
  snapshot.permissionMode !== PermissionModes.Auto,
);
```

两件事：

- **用户改了输入**（`handleResult.input !== undefined`）→ 用新输入复查；
- **用户没改** → 用批准前的规则快照复查，避免规则在弹窗期间变化导致反复。

注释里那句「Approval settles the ask」说的是：
用户点了同意，不能再因为 Auto 判定器又弹一次。
否则用户会陷入无限弹窗。

## 五、三种核心模式

`createPermissionModes`（`packages/core/src/permissions/manager/permission-manager.ts:97-`）
定义每个模式怎么处理 ask。`AcceptEdits` 的实现最能说明问题（`:119-140`）：

```ts
[PermissionModes.AcceptEdits]: {
  resolve: (ask, ctx) => {
    if (isUnskippable(ask)) {
      return stampPoint(ask, 'mode.needs_user.keep_ask');
    }
    if (isSafetyObjection(ask)) {
      return stampPoint(ask, 'mode.safety_objection.keep_ask');
    }
    if (
      (ctx.coveredByAcceptEdits !== true &&
        ask.extra?.acceptEditsEligible !== true) ||
      ask.reason.attribution.type === 'hook'
    ) {
      return stampPoint(ask, 'mode.accept_edits.ineligible.keep_ask');
    }
    return {
      kind: 'allow',
      extra: { ...ask.extra, decisionPoint: 'mode.accept_edits.allow' },
    };
  },
```

四个判断，前三个都是「保持询问」：

1. `isUnskippable` —— 不可跳过的（比如明确的高危操作）；
2. `isSafetyObjection` —— 安全异议；
3. 不满足编辑条件，**或来源是钩子**。

第 3 条的后半句很有意思：`ask.reason.attribution.type === 'hook'`。
**钩子拦下的请求，即使在 AcceptEdits 模式下也要问用户。**
因为钩子代表外部策略，用户开「自动接受编辑」不等于同意外部策略。

`stampPoint` 打的是决策点标记（`mode.accept_edits.allow` 等）。
这让每一次判定都能事后归因到具体规则——出问题能查是哪条规则放行的。

## 六、Auto 模式的三级判定

`permissions/permission-modes/auto/` 目录下有五个判定器：

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `classifier.ts` | 1,511 | 主判定器 |
| `llm-transcript.ts` | 687 | 把上下文整理成 LLM 可读 |
| `auto-classifier.ts` | 431 | 判定器封装 |
| `dangerous-rules.ts` | 398 | 危险规则表 |
| `jev-classifier.ts` | 352 | JEV 判定 |

三级结构：**规则表 → 判定器 → LLM 兜底**。

`dangerous-rules.ts` 是最快的一层，硬编码匹配；
`classifier.ts` 处理规则表覆盖不到的；
`llm-transcript.ts` 负责把会话上下文压成提示词，交给模型判断。

层级的意义是成本：规则表几乎零成本，
LLM 判定要一次请求。能用规则解决就不该调模型。

## 七、工程暗坑

**1. `runChecker` 的 `catch` 返回 deny**
`:344-346`：

```ts
} catch {
  return { kind: 'deny' };
}
```

判定器抛异常时一律拒绝。**不是 allow 也不是 ask**。
这条保证了「判定器写错了也不会放行」。

**2. `askHandler` 抛异常等价于 aborted**
`:164-168`：

```ts
try {
  handleResult = await this.askHandler(ctx);
} catch {
  handleResult = { kind: 'aborted' as const };
}
```

提问处理器崩了，按「用户中止」处理，随后走 `kind !== 'approved'` 的分支降级成 deny。
不重试、不静默放行。

**3. 未注册工具的错误处理看调用方**
`:216-224`：

```ts
if (
  !fallbackUnregistered ||
  (error as Error | undefined)?.name !== 'UnregisteredToolError'
) {
  throw error;
}
return unregisteredToolDecision(this.request);
```

`fallbackUnregistered` 只对 `UnregisteredToolError` 生效。
别的错误照抛——不做无差别兜底。

**4. 钩子来源的 ask 不能被模式跳过**
回到第五节：`attribution.type === 'hook'` 是保持询问的充分条件。
实现自定义模式时如果漏了这条，等于给钩子开了旁路。

**5. 钩子输出有 10,000 字符上限**
`hooks/types.ts:560`：

```ts
export const MAX_HOOK_OUTPUT_LENGTH = 10000;
```

超出部分写到文件，只回一段 `Full output saved to: ` 前缀提示（`:567`）。
避免钩子脚本吐一大坨内容把上下文塞爆。

**6. `PreToolUse` 的裁决进判定上下文**
`runChecker` 里 `preToolUseHookVerdict` 是 `ToolCheckContext` 的字段（`:304`）。
也就是说钩子可以先行表态，判定器能看到它。
两道闸门不是串行无关，而是后者读前者的输出。

## 八、本章源码索引

| 文件 | 行数 | 本章用到的位置 |
| --- | --- | --- |
| `packages/core/src/hooks/types.ts` | 1,865 | `:19-27` ConfigSource，`:41-70` 29 个事件 |
| | | `:120-125` HookType，`:560-567` 输出上限 |
| `packages/core/src/hooks/hookRunner.ts` | 2,602 | 钩子执行器 |
| `packages/core/src/hooks/hookEventHandler.ts` | 1,797 | 事件分发 |
| `packages/core/src/hooks/hookSystem.ts` | 834 | 系统装配 |
| `packages/core/src/hooks/hookRegistry.ts` | 800 | 注册表 |
| `packages/core/src/hooks/hookPlanner.ts` | 423 | 钩子链规划 |
| `packages/core/src/hooks/hookAggregator.ts` | 381 | 多钩子结果聚合 |
| `packages/core/src/permissions/manager/tool-check.ts` | 411 | `:124-225` run 主循环 |
| | | `:292-347` runChecker |
| `packages/core/src/permissions/manager/permission-manager.ts` | 412 | `:97-` createPermissionModes |
| `packages/core/src/permissions/manager/session-permission-manager.ts` | 771 | 会话级权限 |
| `packages/core/src/permissions/permission-modes/auto/classifier.ts` | 1,511 | Auto 主判定器 |
| `packages/core/src/permissions/permission-modes/auto/dangerous-rules.ts` | 398 | 危险规则表 |
| `packages/core/src/permissions/settings/permissionsLoader.ts` | 460 | 规则加载 |

## 九、自己动手验证

```bash
node qw-examples/check/08-permission-hooks.mjs
```

预期输出：

```text
hook events: 29
hook types: 5
config sources: 7
permission modes: 5
checker catch -> deny: true
ask without handler -> deny: true
  1865 hooks/types.ts
  2602 hooks/hookRunner.ts
  1797 hooks/hookEventHandler.ts
   411 permissions/manager/tool-check.ts
   412 permissions/manager/permission-manager.ts
   398 permissions/permission-modes/auto/dangerous-rules.ts
```

改一处试试：把 `runChecker` 的 `catch` 分支从 `{ kind: 'deny' }` 改成
`{ kind: 'allow' }`。
然后故意让某个判定器抛异常（比如传一个畸形输入）。
结果是：所有判定器崩溃的场景都变成静默放行——
包括本该拒绝的写文件操作。这一行就是整套权限体系的地基。

## 十、下一步

Part B 到此结束。我们已经拆完内核的四层：

- 入口与总线（Q03）；
- 对话与回合（Q04）；
- 请求装配（Q05）；
- 消息协议（Q06）；
- 工具与 MCP（Q07）；
- 权限与钩子（Q08）。

Part C 转向「上下文与资产」：
上下文怎么攒、怎么压（Q09、Q10），
技能与插件怎么挂进来（Q11），
Agent 与 Workflow 怎么编排（Q12）。

---

> **本章读完你应该能回答**：
> ① 钩子和权限谁先谁后？
>    ——钩子的裁决（`preToolUseHookVerdict`）进入权限判定的上下文，后者读前者。
> ② 想 ask 但没人能问，怎么办？
>    ——降级成 deny，不是 allow。
> ③ 为什么钩子来源的 ask 在 AcceptEdits 下也要问？
>    ——用户开自动接受编辑，不等于同意外部钩子策略。
> ④ 判定器抛异常时怎么处理？
>    ——一律 deny。判定器写错也不会放行。
> ⑤ 钩子能不能触发钩子？
>    ——能（`prompt` / `agent` 型），所以需要 `hookPlanner` 管理链深度。
