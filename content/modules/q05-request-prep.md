---
title: "一次请求的七步装配 —— 1,132 行里发生了什么"
order: 5
part: "Part B · 内核"
eyebrow: "Q05"
meta: "1,948 字 · 173 行代码 · 15 块 · 约 16 分钟"
status: sample
snapshot: "1.0.0-preview @ 2026-11-12"
---

Q04 讲到 Conversation 决定「再问一次模型」，它只做一件事：
发布 `llm.request`。

从这条事件到真正发出去的 HTTP 请求之间，横着一个
`packages/core/src/event-bus/llm/request-preparation.ts`（1,132 行）。
本章把它拆成七步，每一步回答一个具体问题。

## 一、LlmHandler 只有四个方法

`packages/core/src/event-bus/llm-handler.ts` 共 312 行，
类本身只有四个方法（`:54-142`）：

| 方法 | 行 | 职责 |
| --- | --- | --- |
| `register()` | `:54-58` | 只订阅 `llm.request` 一个事件 |
| `handle()` | `:61-71` | 取 state、校 round，然后 `void` 启动 |
| `runRound()` | `:73-112` | 装配 → 推理 → 结算，三行调用 |
| `settle()` | `:114-142` | 写 `round.modelResult`，发布 `llm.settled` |

`runRound` 的骨架非常短（`:73-112`）：

```ts
private async runRound(state: QueryState, round: QueryRound): Promise<void> {
  const ctx: LlmRoundContext = {
    state,
    round,
    signal: state.control.abort.signal,
    emit: (output) => emitOutput(this.bus, state, output),
  };
  const preparation = await prepareRequest(ctx);
  if (preparation.kind === 'stopped') {
    this.settle(state, round, {
      ...emptyResult(preparation.prepared),
      outcome: 'failed',
      failure: preparation.failure,
      error: preparation.error,
    });
    return;
  }
  const inference = await runInference(
    ctx,
    preparation.request,
    (block, responseId, assistantMessageUuid) =>
      publishFor(
        this.bus,
        state,
        'llm.tool_use',
        { block, responseId, assistantMessageUuid },
        round.roundId,
      ),
  );
  this.settle(
    state,
    round,
    assembleModelResult(
      ctx,
      preparation.prepared,
      preparation.request,
      inference,
    ),
  );
}
```

三个动词：**准备、推理、结算**。这跟 Q03 讲的「handler 只做一件事」一致——
LlmHandler 不决定继续还是收工，只管把这一轮跑完然后广播结果。

注意 `handle()` 里用的是 `void this.runRound(...)`（`:67`），
**故意不 await**。事件总线的订阅者回调不能阻塞发布方，
出错时通过 `bus.reportFailure('llm', event, error)` 转成 `handler.failed` 事件。

## 二、prepareRequest：36 行门面，四个分支

`prepareRequest`（`:209-244`）只做前置处理，真正的装配交给 `assembleRequest`：

```ts
export async function prepareRequest(
  ctx: LlmRoundContext,
): Promise<PreparationResult> {
  const { state, round, signal } = ctx;
  const { input } = state;
  const options = input.params;
  const work: PreparationWork = {
    runtime: state.runtime,
    model: state.model,
    sessionContextReason: state.sessionContextReason,
  };

  if (!work.model) await selectInitialModel(ctx, work);
  if (round.reason === 'reactive_compact') {
    const recovered = await runReactiveCompact(ctx, work);
    if (!recovered) {
      return {
        kind: 'stopped',
        failure: 'reactive_compact_failed',
        prepared: preparedFrom(ctx, work),
        error: round.cause,
      };
    }
  }
  if (round.reason === 'tool_results' && options.attachmentCtx) {
    await injectInterTurnAttachments(ctx, work, options.attachmentCtx);
  }

  if (signal.aborted) {
    return {
      kind: 'stopped',
      failure: 'aborted_before_request',
      prepared: preparedFrom(ctx, work),
    };
  }
  return assembleRequest(ctx, work);
}
```

四个分支的顺序有讲究：

1. **没选过模型就先选** —— `selectInitialModel` 只在第一次请求时跑；
2. **反应式压缩优先** —— 它是上一轮 `prompt_too_long` 的补救，必须先于一切；
3. **工具返回后补附件** —— 只有 `reason === 'tool_results'` 才注入回合间附件；
4. **最后查中止** —— 前面几步都是 `await`，期间用户可能已经取消。

`kind` 只有两个值：`stopped` 与 `ready`。
所有「不该发了」的情况都收敛成 `stopped` + 一个 `LlmFailureKind`，
由 `LlmHandler` 统一转成 `outcome: 'failed'` 结算。

## 三、七步装配

`assembleRequest`（`:669-1010`，342 行）是整个内核最长的一个函数。
按执行顺序切成七步：

| # | 步骤 | 做什么 | 行 |
| --- | --- | --- | --- |
| 1 | 输出上限重选 | `maxOutputTokensOverride` 变了就重选模型 | `:686-711` |
| 2 | 环境消息 | 注入环境上下文（`getEnvironmentMessages`） | `:723-733` |
| 3 | 待发回合物化 | `requestMessages.prepare()` 把 pending 拆成消息 | `:739-743` |
| 4 | 钩子补注入 | 抽干异步钩子上下文与迟到的附件 | `:748-775` |
| 5 | 压缩 | `compressionPipeline.compress()` | `:799-925` |
| 6 | 会话上下文 | 注入 session context（含 git 快照） | `:930-946` |
| 7 | 编号与容量 | 分配 `modelRequestId`、查上下文上限 | `:948-999` |

第 5 步是唯一会**替换整个历史**的步骤。压缩成功后要重放全部消息
（`:891`），让消费端能重建可见会话；然后重新装配一次会话：

```ts
work.runtime = createContinuationState(
  work.runtime,
  { messages: nextMessages },
  { reason: 'next_turn' },
);
// 历史已经替换，不复用压缩前的 usage 或投影结果。
latestUsage = undefined;
conversation = prepareConversation();
```

所以 `prepareConversation` 在 `assembleRequest` 里一共被调用 **3 次**：
一次初装、一次压缩后、一次会话上下文注入后。
每次都重算 token 数——因为每次的输入都不一样。

## 四、消息拼装：三段拼一

`prepareRequestConversation`（`packages/core/src/event-bus/llm/request-preparation-helpers.ts:33-86`）
负责把历史变成「能发给模型的消息数组」。
普通路径（非 fork）只有三行核心（`:63-67`）：

```ts
runtimeMessages = [...prefixMessages, ...history, ...pendingTurnMessages];
// Prefix and history are normalized together so adjacent user messages merge
// identically in the parent request and every cache-sharing fork. The prefix
// is ephemeral and never stored in conversation history.
messages = normalizeMessagesForAPI(runtimeMessages, projectionOptions);
```

三段含义：

| 段 | 来源 | 是否入历史 |
| --- | --- | --- |
| `prefixMessages` | `startupMemoryPrefix`（启动记忆） | 否，临时 |
| `history` | `getRequestBaseHistory(state, pendingTurnMessages)` | 是 |
| `pendingTurnMessages` | 本回合尚未落盘的用户消息 | 请求后落盘 |

注释里那句「Prefix and history are normalized together」是关键。
如果把 prefix 单独归一化再拼接，相邻的两条 user 消息合并逻辑
会跟父请求不一致——而 fork 出来的子请求要共享 prompt 缓存，
前缀差一个字节，缓存就全失效。

所以这里强制**先拼再归一化**。代价是 `runtimeMessages` 保留全量，
token 计数要基于它而不是 `messages` 算——`countRequestTokens` 同时收两者（`:70-78`）。

## 五、工具清单怎么来

`getToolSchemas`（`packages/core/src/event-bus/llm/request-preparation.ts:162-173`）只有 12 行：

```ts
export function getToolSchemas(
  state: QueryState,
  modelKey: string,
): ModelStreamTool[] {
  return (
    state.input.params.toolRegistry?.getSchema(modelKey, {
      // The CLI intentionally has no model allowlist for this prompt behavior.
      // `--bare` is the only minimal mode and never enters a
      // tool-bearing query.
      preReadLineDropped: state.input.params.preReadLineDropped !== false,
    }) ?? []
  );
}
```

两点值得注意：

- **按模型取 schema**：`getSchema(modelKey, ...)` 而不是无参。
  不同模型支持的工具集可能不同（比如某些模型不支持并行调用）；
- **没有工具就返回空数组**，不是 `undefined`。
  空数组在协议层表示「这个请求不带工具」，
  而 `undefined` 会被某些 provider 当成「用默认工具」。

`preReadLineDropped` 这个参数控制一个降级行为：
把工具描述里的首行去掉。这是为小上下文模型准备的——
工具描述的首行通常是长句说明，占用不少 token。

## 六、推理：一个回调撑起流式

`runInference`（`packages/core/src/event-bus/llm/inference-round.ts:47-238`，192 行）
负责真正调用模型。它的签名有个特点——第三个参数是回调：

```ts
export async function runInference(
  ctx: LlmRoundContext,
  assembled: AssembledRequest,
  dispatchToolUse: ToolUseDispatcher,
): Promise<InferenceResult> {
```

`dispatchToolUse` 在模型流出 `tool_use` 块的那一刻被调用，
`LlmHandler` 传进去的实现就是「发布 `llm.tool_use` 事件」：

```ts
(block, responseId, assistantMessageUuid) =>
  publishFor(
    this.bus,
    state,
    'llm.tool_use',
    { block, responseId, assistantMessageUuid },
    round.roundId,
  ),
```

这条链路让**工具可以在模型还没说完时就开始执行**。
ToolHandler 订阅 `llm.tool_use`（Q03 讲过），收到就去跑工具，
不必等 `llm.settled`。并行工具调用的加速就来自这里。

`llm.settled` 与 `llm.tool_use` 的分工：

| 事件 | 时机 | 消费者用它做什么 |
| --- | --- | --- |
| `llm.tool_use` | 流中出现工具块时 | Tool 立刻开跑 |
| `llm.settled` | 整个响应结束 | Conversation 决定下一步 |

## 七、结算：把流结果拍扁成快照

`assembleModelResult` 把「流式过程」压成「一份可判定的事实」。
它调的两个函数在 `packages/core/src/event-bus/llm/result-assembly.ts`：

`extractToolUseBlocks`（`:27-38`，12 行）：

```ts
export function extractToolUseBlocks(
  message: ModelMessage,
  config?: Config,
  capturedMcpIdentities?: Map<string, McpInfo>,
): ModelToolUseBlock[] {
  return message.blocks.flatMap((block) => {
    if (block.type !== 'tool_use') return [];
    const tool = normalizeModelToolUseBlock(block);
    captureMcpToolIdentity(tool, config, capturedMcpIdentities);
    return [tool];
  });
}
```

`splitAssistantMessage`（`:41-106`）做另一件事：把一个 `ModelMessage`
**按块拆成多条** `AssistantMessage`。

为什么拆？因为历史存储是按块索引的。
一个响应里有 2 段文本 + 3 个工具调用，就要拆成 5 条记录，
每条带自己的 `index`。最后一块才承载 `stopReason` 和 `usage`（`:74-75`）：

```ts
const blockMessage: ModelMessage = {
  ...message,
  stopReason: isLastBlock ? message.stopReason : undefined,
  usage: isLastBlock ? message.usage : undefined,
  blocks: [normalizeModelBlockForHistory(block)],
};
```

否则 5 条记录每条都带一份 usage，累计起来就是 5 倍。

结算函数 `settle()` 还有个双保险（`packages/core/src/event-bus/llm-handler.ts:114-117`）：

```ts
private settle(state: QueryState, round: QueryRound, result: ModelResult) {
  if (this.store.get(state.input.queryId) !== state) return;
  if (state.round !== round || round.modelResult) return;
  round.modelResult = result;
```

两个 `if`：state 已销毁（查询结束）、round 已换或已有结果，都直接丢弃。
**`llm.settled` 因此永远只会发一次。**

## 八、失败分类：八种，一个函数

`classifyRequestFailure`（`packages/core/src/event-bus/llm-handler.ts:159-170`）
把异常映射成 `LlmFailureKind`（8 种）：

```ts
function classifyRequestFailure(
  signal: AbortSignal,
  error: unknown,
): LlmFailureKind {
  const isAbort = signal.aborted || error?.name === 'AbortError';
  if (isAbort) {
    return 'aborted';
  }
  if (isPromptTooLongError(error)) return 'ptl';
  if (getErrorStatus(error) === 406) return 'refusal_406';
  return 'transport';
}
```

这里只判四种，另外四种（`aborted_before_request` / `context_limit` /
`reactive_compact_failed` / `max_tokens_escalatable`）由
`prepareRequest` 或结果装配阶段直接给出。

顺序很重要：**先判 `signal.aborted`，再判错误类型**。
用户取消时异常常常是 `AbortError`，但也可能是网络层抛的 `TypeError`；
只要信号是中止状态，一律归为 `aborted`，不被错误类型带偏。

`406` 这个状态码硬编码在这里——它表示模型拒绝回答（内容安全）。
单独分出一个 `refusal_406` 而不是并进 `transport`，
因为两者的处理完全不同：`transport` 可以重试，`refusal` 必须直接收工。

## 九、工程暗坑

**1. `prepareConversation` 的返回值必须重新赋给 `conversation`**
`assembleRequest` 里三次调用都写成 `conversation = prepareConversation(...)`。
如果只 `await` 不赋值，压缩后仍然用旧的历史发请求——
压缩等于白做，下一个请求立刻又 `prompt_too_long`。

**2. 压缩后 `latestUsage` 必须置 `undefined`**
源码注释写得很直白（`:915`）：

```ts
// 历史已经替换，不复用压缩前的 usage 或投影结果。
latestUsage = undefined;
```

`latestUsage` 是用来估算 token 的。压缩前的 usage 对应的是旧历史，
拿它当新历史的基线，估算值会偏大，导致连续误触发压缩。

**3. `yieldToEventLoop()` 之后必须重查中止**
`:992-999` 这段：

```ts
await yieldToEventLoop();
if (signal.aborted) {
  return {
    kind: 'stopped',
    failure: 'aborted_before_request',
    prepared: preparedFrom(ctx, work, baseExtra),
  };
}
```

`yieldToEventLoop` 把控制权交回微任务队列，让消费端读完准备阶段的消息。
这一让，用户就可能在此时点下取消。所以**让出前后各查一次**
（前面 `:237` 一次、这里一次），中间那段窗口不能漏。

**4. 工具 schema 为空数组不等于「没工具」**
`getToolSchemas` 的 `?? []` 会让「registry 返回 undefined」和
「registry 明确返回空」变成同一个值。
Q04 里 `needsToolSettlement` 判的是 `toolExecutor !== undefined`，
不是 schema 非空——这个设计上是对的（有执行器就可能要结算），
但如果你的自定义 provider 需要区分两者，得自己加标志。

**5. `splitAssistantMessage` 的 `includeEmpty` 控制空响应**
响应为空时（`:57-69`），`includeEmpty: true` 会造一条空 `AssistantMessage`，
`false` 则返回空数组。
中断场景必须 `true`——否则历史里什么都没有，
下一轮模型看不到「上次被打断了」。

## 十、本章源码索引

| 文件 | 行数 | 本章用到的位置 |
| --- | --- | --- |
| `packages/core/src/event-bus/llm-handler.ts` | 312 | `:54-58` register，`:61-71` handle |
| | | `:73-112` runRound，`:114-142` settle，`:159-170` 失败分类 |
| `packages/core/src/event-bus/llm/request-preparation.ts` | 1,132 | `:209-244` prepareRequest |
| | | `:162-173` getToolSchemas，`:669-1010` assembleRequest |
| `packages/core/src/event-bus/llm/request-preparation-helpers.ts` | 200 | `:33-86` prepareRequestConversation |
| `packages/core/src/event-bus/llm/inference-round.ts` | 238 | `:47-238` runInference |
| `packages/core/src/event-bus/llm/result-assembly.ts` | 126 | `:27-38` extractToolUseBlocks |
| | | `:41-106` splitAssistantMessage |
| `packages/core/src/event-bus/llm/inference.ts` | 142 | `:104-` toTurnStepResult |

## 十一、自己动手验证

```bash
node qw-examples/check/05-request-prep.mjs
```

预期输出：

```text
llm subscribes: 1
methods: 4
prepare kinds: kind: 'ready',kind: 'stopped'
prepareConversation calls: 3
prepareRequest span: 36 start line 209
LlmFailureKind: 8
tokenCount inputs: 9
  311 event-bus/llm-handler.ts
 1132 event-bus/llm/request-preparation.ts
  200 event-bus/llm/request-preparation-helpers.ts
  142 event-bus/llm/inference.ts
  238 event-bus/llm/inference-round.ts
  126 event-bus/llm/result-assembly.ts
```

改一处试试：把 `prepareRequestConversation` 里的
`messages = normalizeMessagesForAPI(runtimeMessages, ...)` 改成两次归一化——
先 `normalizeMessagesForAPI(prefixMessages)` 再拼 history。
跑一次 fork 子代理，观察 prompt 缓存命中率：会从接近 100% 掉到很低。
这就是注释里那句「prefix and history are normalized together」的代价。

## 十二、下一步

本章的「消息」始终是个黑箱——我们知道有三段拼起来，
但不知道 `Message` 这个类型里到底有什么。
下一章 Q06 拆 `packages/core/src/protocol/` 这一层：
一份内部消息如何投影成三家 provider 的格式，以及为什么投影层要独立存在。

---

> **本章读完你应该能回答**：
> ① `llm.request` 到 HTTP 请求之间有几个阶段？
>    ——`prepareRequest` 前置四分支 + `assembleRequest` 七步。
> ② 为什么 `prepareConversation` 要调三次？
>    ——初装、压缩后、会话上下文注入后，输入都变了。
> ③ 工具为什么能在模型说完之前开跑？
>    ——`llm.tool_use` 是流中事件，不等 `llm.settled`。
> ④ 一个响应为什么要拆成多条 `AssistantMessage`？
>    ——按块索引存储，最后一块才带 `stopReason` 与 `usage`。
> ⑤ 用户取消时为什么不会被误判成网络错误？
>    ——先判 `signal.aborted`，再看错误类型。
