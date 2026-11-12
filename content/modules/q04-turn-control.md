---
title: "对话与回合 —— 一次请求如何被五个 handler 接力跑完"
order: 4
part: "Part B · 内核"
eyebrow: "Q04"
meta: "2,095 字 · 189 行代码 · 18 块 · 约 18 分钟"
status: final
snapshot: "1.0.0-preview @ 2026-11-12"
---

Q03 讲了事件怎么在总线上流动，但只到「事件被投递」为止。
真正把一次对话往前推的，是**四个 handler 的接力**：
有人收输入、有人调模型、有人跑工具、有人判终态。
本章就拆这台接力机器。

## 一、回合是什么：`QueryRound` 的十个字段

「回合」不是模型回复一次，而是**一次请求及其后续**。
它的数据结构是 `QueryRound`（`packages/core/src/event-bus/state.ts:137-155`）：

```ts
export interface QueryRound {
  readonly roundId: string;
  readonly reason: RequestReason;
  readonly requestIndex: number;
  /** Written once by Tool, then tool.settled. */
  toolSummary?: ToolExecutionSummary;
}
```

三个 `readonly` 是创建时就定死的身份：`roundId`（随机）、`reason`（为什么发这次请求）、
`requestIndex`（会话里第几次）。其余七个都是**可选的，且由不同 handler 写入**。

源码里这几个字段各自带着注释：'Written once by Llm'、'Written once by Tool'。
这不是随手写的。每个字段有**唯一写入者**，且只写一次。
这个约定让「谁改了状态」永远只有唯一答案——
出问题时不用猜是 Llm 还是 Tool 把 `modelResult` 弄脏了。

## 二、dispatch：五路事件分流

所有事件进同一个入口。
`ConversationHandler.dispatch`（`packages/core/src/event-bus/conversation-handler.ts:88-105`）
是个五路 switch：

```ts
private async dispatch(state: QueryState, event: AnyBusEvent): Promise<void> {
  switch (event.type) {
    case 'query.submitted':
    case 'llm.settled':
    case 'tool.settled':
    case 'query.cancelled':
    case 'handler.failed':
```

五种事件：用户提交、模型落定、工具落定、取消、handler 自己失败。
**只有这五种**。Q03 讲过的其它事件类型（流式增量、状态通知）不经过这里——
它们是「给别人看的」，不驱动对话前进。

好处很直接：**对话状态机只有五个入口**。
想知道「为什么会进入这个状态」，只需查这五个 case 谁被触发了。

## 三、谁写哪个字段：四方的分工

`QueryRound` 的注释已经把分工写出来了。整理成表：

| 字段 | 写入者 | 什么时候 |
| --- | --- | --- |
| `selection` `taskTrigger` | Llm | 首次模型选择之后 |
| `dispatch` | Llm | 响应开始流式之前 |
| `modelResult` | Llm | 响应结束，随后发 `llm.settled` |
| `tools` | Tool | 本回合工具工作态 |
| `toolSummary` | Tool | 工具结束，随后发 `tool.settled` |

顺序是有向的：`dispatch` → `modelResult` → `tools` → `toolSummary`。
这条链解释了第五节要讲的「七道门」为什么按那个顺序排——
**门的存在是为了保护字段的写入前提**。

两个函数说明了这种保护：
`writePrepared`（`model-settled.ts:65-80`）只在 `prepared.requestSent` 为真时，
才把 `requestIndex` 与 `toolUseContext` 写回 `state`——
**请求没真发出去，就不认这是新的一轮**。
`needsToolSettlement`（`:82-91`）则在 `toolExecutor` 存在、且
`dispatchedToolUseBlocks` 或 `toolUseBlocks` 非空时返回真——
没有工具调用的回合，不该走工具结算。
## 四、handleLlmSettled：两条大路

`onLlmSettled` 交棒给 `model-settled.ts` 的 `handleLlmSettled`（`:93-103`），
它只有两行有效判断：

```ts
export async function handleLlmSettled(
  ctx: ConversationContext,
  round: QueryRound,
): Promise<void> {
  const result = round.modelResult!;
  if (
    result.outcome === 'failed' &&
    result.failure !== 'max_tokens_escalatable'
  ) {
    await handleFailedRequest(ctx, round, result);
    return;
  }
  await handleResponse(ctx, round, result);
}
```

`outcome` 三个值：`complete` / `interrupted` / `failed`（`events.ts:34`）。
分叉点只有一个例外：**`max_tokens_escalatable` 虽属 failed，但不当失败处理**。
输出被截断是可救的——请求方只是把 `maxOutputTokens` 调大重发就行，
所以它走 `handleResponse` 的正常路径，在内部专门有一段
（`model-settled.ts:360-371`）：

```ts
if (result.failure === 'max_tokens_escalatable') {
  runLogger.debug(
    [
      '[AgentLoop] max-output-tokens escalation: ',
      state.runtime.maxOutputTokensOverride ??
        state.model?.initialMaxOutputTokens,
      ' -> ',
      result.nextMaxOutputTokens,
    ].join(''),
  );
  state.runtime = buildMaxOutputTokensEscalationState({
    state: state.runtime,
    nextMaxOutputTokens: result.nextMaxOutputTokens!,
  });
  state.cumulativeResponseText = '';
  await ctx.request('escalation');
  return;
}
```

堆栈靠 `state.runtime` 逐层传递：

```text
query.submitted
  -> handleSubmitted        request('initial')
    -> llm.settled
      -> handleLlmSettled
        -> handleResponse
          -> 无工具 + end_turn  -> runStopHook -> finish('end_turn')
          -> 有工具              -> afterTools('tool_results')
          -> 截断可救            -> request('escalation')
          -> 流中断无工具         -> request('stream_recovery')
          -> 被取消              -> finish('abort')
```

## 五、handleResponse 的七道门

`handleResponse`（`:319-724`）是全书第二长的函数，406 行。
它按顺序过七道门，每道门都是一次 `return`：

| # | 条件 | 出口 |
| --- | --- | --- |
| 1 | `failure === 'max_tokens_escalatable'` | `request('escalation')` |
| 2 | `interrupted` 且 `toolUseBlocks.length === 0` | `finish` |
| 3 | `stopReason === 'refusal'` | `finishRefusal` 或 `afterTools('refusal')` |
| 4 | `malformedToolUse` | `request('malformed')` 或 `finish(error)` |
| 5 | `cancelled.aborted` 且非 interrupted | `finish('abort')` |
| 6 | `interrupted` 且无工具 | `request('stream_recovery')` |
| 7 | `toolUseBlocks.length === 0` | `runStopHook` |

七道都不命中，才落到最后两行（`:720-723`）：

```ts
if (interrupted && settled.terminalInterruption) {
  ctx.cancelTools('terminal_interruption');
}
ctx.afterTools({ kind: 'tool_results' });
```

**这就是 Q03 那个问题的答案**：判断依据不是「模型说了什么」，
而是 `toolUseBlocks.length`。有工具调用就必须先让工具跑完，
哪怕模型同时输出了完整答案。

第 7 道门最容易被忽略。`runStopHook`（`:838-908`）在收工前还要问一次钩子：

```ts
if (continuation.terminalReason === 'stopped') {
  finishData('stopped_by_after_hook');
  await ctx.finish({
    reason: 'end_turn',
    terminalDetail: 'hook_stopped',
    ...ctx.terminalBase(settled.nextTurnCount),
  });
  return;
}
if (continuation.continuationMessage && continuation.nextState) {
  ctx.emit(continuation.continuationMessage);
  state.runtime = continuation.nextState;
  state.cumulativeResponseText = '';
  await ctx.request('stop_hook');
  return;
}
```

所以「模型说完最后一句话」并不等于结束。
Stop 钩子可以投票两件事：停止（`hook_stopped`），或者
**塞一条消息进去再来一轮**（`request('stop_hook')`）。

## 六、onToolSettled 与 afterTools 的耦合

工具结算走另一条路（`conversation-handler.ts:130-146`）：

```ts
private async onToolSettled(
  ctx: ConversationContext,
  event: BusEvent<'tool.settled'>,
): Promise<void> {
  const { state } = ctx;
  const round = currentRound(state, event.roundId);
  if (!round?.toolSummary || !state.flow.toolsInFlight) return;
  state.flow.toolsInFlight = false;
  if (state.flow.failure) {
    await this.finalizeFailure(ctx);
    return;
  }
  const continuation = state.flow.afterTools;
  state.flow.afterTools = undefined;
  if (!continuation) return;
  await this.continueAfterTools(ctx, continuation);
}
```

关键在 `state.flow.afterTools`。
模型结算时（`handleResponse` 结尾）并不知道工具会跑成什么样，
所以它只**登记意图**：`ctx.afterTools({ kind: 'tool_results' })`。
等工具结算事件到了，`onToolSettled` 才取出这个意图并执行。

`afterTools` 的实现只有一行（`conversation-handler.ts:262-264`）：

```ts
afterTools: (continuation) => {
  state.flow.afterTools = continuation;
},
```

意图有六种（`state.ts:210-216`）：

```ts
export type ToolContinuation =
  | { kind: 'abort_streaming' }
  | { kind: 'request_error'; error: unknown; isModelRefusal: boolean }
  | { kind: 'refusal' }
  | { kind: 'aborted_after_assistant' }
  | { kind: 'tool_results' }
  | { kind: 'release_then_request'; reason: RequestReason; cause?: unknown };
```

最后一种 `release_then_request` 是唯一带 `reason` 的，
用于 PTL 与反应式压缩：先释放工具占用的并发槽位，再重发请求。
这解释了为什么它是独立一种——它的参数结构跟其他五种不一样。

## 七、终态与细节：五个 reason，十六种细节

`ctx.finish()` 最终产出 `Terminal`（`packages/core/src/core/query-event.ts:114-138`）。
`reason` 只有五个值，但实际业务关心的是更细的 `terminalDetail`。

于是有了 `query-terminal.ts` 的分类函数（`:55-116`），
把 `Terminal` 压成 16 种 `TaskTerminalReasonDetail`：

| 细节 | 触发条件 |
| --- | --- |
| `aborted_streaming` | `reason='abort'` 且 `abortKind` 已设 |
| `aborted_tools` | 同上，工具阶段取消 |
| `repeated_tool_call_denied` | 重复调用被拒的专用 reason |
| `max_turns` | 撞上最大回合数 |
| `hook_stopped` | Stop 钩子投票停止 |
| `model_refusal` | `modelStopReason='refusal'` |
| `prompt_too_long` | `isPromptTooLongError` |
| `post_compact_context_limit` | 压缩后仍超限 |
| `malformed_tool_use_exhausted` | 畸形工具调用重试耗尽 |
| `model_error` | 流无效或畸形工具 |
| `turn_setup_failed` | `reason='error'` 且 `requestIndex === 0` |
| `api_error` | 同上，但已有请求 |
| `unclassified_error` | 错误类型未知 |
| `unclassified_abort` | `reason='abort'` 无 `abortKind` |
| `unclassified_terminal` | 兜底 |
| `completed` | `reason='end_turn'` |

注意 `turn_setup_failed` 与 `api_error` 的区别只看一个数：
`requestIndex === 0`（`:94`）。
首个请求就崩，多半是配置或鉴权有问题；
跑到第 N 个请求才崩，更可能是模型侧的瞬时故障。
这个区分直接影响诊断入口，所以值得单独开两个枚举值。

函数末尾还有一句注释（`:114`）：

```ts
// Concrete fallback: an absent field would stay indistinguishable from
// clients that report no detail.
return { terminalReasonDetail: 'unclassified_terminal' };
```

宁可返回 `unclassified_terminal` 也不返回 `undefined`——
因为 `undefined` 和「客户端没上报」在传输层长得一样，
下游没法区分「不知道」和「没给」。

## 八、QueryTurn 与动态回合预算

前面说的 `turnCount` 是请求计数，`QueryTurn`（`packages/core/src/core/query-turn.ts`，168 行）
是另一套东西：**给钩子用的回合宿主**。

它管六个阶段（`turn-hooks.ts:154-161`）：

```ts
export interface TurnHookRegistrar {
  (stage: 'turn.start', handler: TurnStartHandler): void;
  (stage: 'turn.step', handler: TurnStepHandler): void;
  (stage: 'turn.complete', handler: TurnCompleteHandler): void;
  (stage: 'turn.run.start', handler: TurnRunStartHandler): void;
  (stage: 'turn.step.result', handler: TurnStepResultHandler): void;
  (stage: 'turn.run.end', handler: TurnRunEndHandler): void;
}
```

`step` 是异步中间件（能包住模型调用），其余五个是同步旁听；
这个区分在类型上就写死了——`TurnStepHandler` 返回 `TurnStepStream`，
而 `TurnStepResultHandler` 返回 `undefined`。

`QueryTurn.observe()`（`:61-83`）负责从事件流里摘答案：

```ts
observe(event: QueryEvent): void {
  if (event.type === 'request_start') {
    this.awaitingResponse = true;
    return;
  }
  if (
    event.type !== 'assistant' ||
    event.parent_tool_use_id != null ||
    event.isApiErrorMessage ||
    event.isVirtual
  )
    return;
  if (this.awaitingResponse) {
    this.answerParts = [];
    this.awaitingResponse = false;
  }
  this.answerParts.push(
    ...event.message.content.flatMap((block) =>
      block?.type === 'text' ? [block.text] : [],
    ),
  );
  this.answer = this.answerParts.join('\n').trim();
}
```

四个排除条件：子工具的消息（`parent_tool_use_id != null`）、
错误提示消息、虚拟消息，都不算答案。
`awaitingResponse` 标志保证只取**最后一次请求**的文本——
中间轮次的叙述会被清掉。

回合预算在 `turn-budget.ts`，只有 36 行，核心是这段（`:20-34`）：

```ts
const finalLimit = Math.min(limits[limits.length - 1], hardLimit ?? Infinity);
const stages = [...limits.filter((limit) => limit < finalLimit), finalLimit];
return {
  finalLimit,
  getSnapshot(turnsUsed: number): TurnBudgetSnapshot {
    const stage = stages.findIndex((limit) => limit > turnsUsed);
    if (stage < 0) return { remainingTurns: 0, exhausted: true };
    const previousLimit = stages[stage - 1];
    return {
      remainingTurns: stages[stage] - turnsUsed,
      ...(stage > 0 && turnsUsed === previousLimit
        ? { additionalTurns: stages[stage] - previousLimit }
        : {}),
    };
  },
};
```

这是一个**分级递增**的预算：`limits` 必须是严格递增的累积上限。
比如 `[10, 30, 50]` 表示：先给 10 轮，用完了再批 20 轮，
还没完再批 20 轮，上限 50。
`additionalTurns` 只在恰好用完上一级的那个瞬间出现——
所以前端可以拿它弹一句「已追加 20 轮」。

`hardLimit <= 0` 直接返回 `undefined`（`:19`），
这个返回值被调用方当成「不允许任何模型请求」。

## 九、工程暗坑

**1. `toolsInFlight` 与 `afterTools` 是两个字段，缺一个就卡死**
模型结算时先置 `toolsInFlight = true`（`conversation-handler.ts:120-122`），
再在 `handleResponse` 里登记 `afterTools`。
如果只置前者不登记后者，`onToolSettled` 会把标志翻回 false，
然后因为 `!continuation` 直接 `return`——整个查询静默挂住。
反过来只登记不置位，`onToolSettled` 在第二个 `if` 就 `return`，
意图永远等不到执行。两个字段必须在同一个逻辑步里成对出现。

**2. `flow.failure` 之后所有入口都要先短路**
`onLlmSettled`、`onToolSettled`、`dispatch` 的 `query.cancelled`
三处都有同一个模式：先检查 `state.flow.failure`，有就 `finalizeFailure`。
而 `finalizeFailure` 自己还要再等一次（`:210-214`）：

```ts
if (
  !state.flow.failure ||
  state.flow.llmInFlight ||
  state.flow.toolsInFlight
) return;
await this.finishThrown(ctx, state.flow.failure.error);
```

它必须等两个 in-flight 标志都归零才真正收尾。
否则会在工具还没跑完时就发 `query.finished`，
后续的工具事件全部落空。

**3. `finish` 的幂等靠 `finishing` 标志**
`finish`（`:361-396`）第一行就是 `if (state.flow.finishing) return;`。
因为从「第一个失败」到「最后一个 handler 停手」之间，
可能有多个路径同时想收尾。没有这个标志就会重复发 `query.finished`，
消费端收到两次终态，生成器 `return()` 两次。

**4. `max_turns` 检查放在 `request` 里，不放在 `handleResponse` 里**
`request()` 开头（`:312-340`）先判 `turnCount >= maxTurns`，
超了就直接 `finish({ reason: 'max_turns' })`，且**照样触发 Stop 钩子**。
注释说得很明确：

```ts
// max_turns ends the turn like a normal stop: the Stop hook and its
// TurnComplete still fire, but a continuation request is not accepted and a
// hook failure does not change the max_turns terminal.
```

这是个容易踩的设计点：撞上限**不是异常**，是正常收工；
钩子照样跑，但钩子报错也不能改写终态。

## 十、本章源码索引

| 文件 | 行数 | 本章用到的位置 |
| --- | --- | --- |
| `packages/core/src/event-bus/conversation-handler.ts` | 465 | `:59-71` 订阅，`:88-109` dispatch |
| | | `:111-128` onLlmSettled，`:130-146` onToolSettled |
| | | `:148-185` continueAfterTools，`:210-214` finalizeFailure |
| | | `:262-264` afterTools，`:312-340` max_turns，`:361-396` finish |
| `packages/core/src/event-bus/conversation/model-settled.ts` | 909 | `:82-91` needsToolSettlement |
| | | `:93-103` handleLlmSettled，`:319-724` handleResponse |
| | | `:838-908` runStopHook |
| `packages/core/src/event-bus/conversation/tools-settled.ts` | 368 | `:36-252` handleToolResults |
| `packages/core/src/event-bus/conversation/submit.ts` | 334 | `:44-` handleSubmitted |
| `packages/core/src/event-bus/conversation/context.ts` | 40 | ConversationContext 的九个能力 |
| `packages/core/src/event-bus/state.ts` | 292 | `:210-216` ToolContinuation，`:283-292` currentRound |
| `packages/core/src/core/query-turn.ts` | 168 | `:61-83` observe，`:134-167` complete |
| `packages/core/src/core/query-terminal.ts` | 116 | `:55-116` classifyTaskTerminal |
| `packages/core/src/core/turn-budget.ts` | 36 | 分级递增预算 |
| `packages/core/src/core/turn-hooks.ts` | 664 | `:154-161` 六阶段注册器 |
| `packages/core/src/core/query-event.ts` | 138 | `:114-138` Terminal |

## 十一、自己动手验证

本章的可数断言都写成了一个脚本：

```bash
node qw-examples/check/04-turn-control.mjs
```

预期输出：

```text
subscribes: 5
dispatch cases: 5
ToolContinuation kinds: 6
RequestReason: 9
Terminal.reason: 5
ReasonDetail: 16
turn stages: 6
  168 core/query-turn.ts
  116 core/query-terminal.ts
   36 core/turn-budget.ts
  292 event-bus/state.ts
  465 event-bus/conversation-handler.ts
  909 event-bus/conversation/model-settled.ts
  368 event-bus/conversation/tools-settled.ts
```

改一处试试：把 `needsToolSettlement` 的两个 `length > 0` 改成 `&&`，
跑一次带工具的对话。
结果会是：模型发起了 3 个工具调用，只派发了 1 个（中断场景），
`&&` 判定为 false，`toolsInFlight` 不置位，
`onToolSettled` 直接 `return`——查询挂住，不退不进。
这个 bug 在正常流里看不出来，只在中断时炸。

## 十二、下一步

本章讲完「谁决定继续还是收工」，但没讲**请求是怎么拼出来的**。
`llm.request` 发出去后，`llm-handler.ts`（296 行）接住它，
然后由 `llm/request-preparation.ts`（1,074 行）装配消息、工具清单、系统提示。
下一章 Q05 拆这条链路：一个 `llm.request` 到一次真实 HTTP 调用之间，
到底有几次改写、几层缓存键、几个降级分支。

---

> **本章读完你应该能回答**：
> ① 收到 `llm.settled` 后，靠什么判断继续还是收工？
>    ——`toolUseBlocks.length`，有工具就必须先结算。
> ② 迟到的旧事件为什么不污染新回合？
>    ——`currentRound` 比对随机 `roundId`，第一个 `if` 就丢弃。
> ③ 模型说完最后一句话就算结束吗？
>    ——不算，Stop 钩子还能塞消息再来一轮（`request('stop_hook')`）。
> ④ 撞上 `max_turns` 算不算异常？
>    ——不算，等同正常收工，钩子照跑但改不了终态。
> ⑤ `turn_setup_failed` 和 `api_error` 怎么分？
>    ——只看 `requestIndex` 是否为 0。
