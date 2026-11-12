---
title: "86 行入口与事件总线 —— 三个 handler 如何接力"
order: 3
part: "Part B · 内核"
eyebrow: "Q03"
meta: "3,016 字 · 259 行代码 · 17 块 · 约 15 分钟"
status: sample
snapshot: "1.0.0-preview @ 2026-11-12"
---

一个 Agent 的循环可以写成 `while (true) { 模型; 工具; }`——Pi 教程里那个 960 行的
`agent-loop.ts` 就是这么干的，直白、好读、一眼看穿。

Qwen Code 1.0 Preview 选了反方向。它的 `agent-loop.ts` **只有 86 行**，其中真正的
`query()` 函数 35 行，最后一行是 `return createQueryStream(options, initialModel)`——
把活全推给了事件总线。

这不是偷懒。这是把「谁在什么时候做什么」从**调用栈**搬到了**事件流**。

> 本章读的是 `packages/core/src/event-bus/` 下的五个文件（共 1,809 行）与
> `packages/core/src/core/agent-loop.ts`（86 行）。读完你应该能回答：
> 一次对话里，谁决定了「再问一次模型」？为什么三个 handler 不会互相堵死？
> 为什么取消能立刻生效？

## 一、入口只有 35 行

先看完整函数。这是全仓库最重要的 35 行：

<!-- file: qwen-code-1.0.0-preview/packages/core/src/core/agent-loop.ts:51-85 -->
```ts
export function query(
  options: QueryParams,
): AsyncGenerator<QueryEvent, Terminal> {
  if (options.compactSelection && options.modelPurpose !== 'compact') {
    throw new Error('compactSelection is only supported for compact queries');
  }
  const agentDefaults =
    options.config &&
    options.isSubagent &&
    (options.modelPurpose === undefined ||
      options.modelPurpose === 'task' ||
      options.modelPurpose === 'fork')
      ? readAgentSelectionDefaults(
          options.config,
          {
            agentId: options.agentId ?? options.promptId,
            agentType: options.agentType,
          },
          options.modelPurpose,
        )
      : undefined;
  // Before selection, use the existing request intent for attribution.
  // Inference and post-selection diagnostics use the Provider's
  // final selection.
  const initialModel =
    (options.modelPurpose === 'fork' ||
      options.modelPurpose === 'side_question'
      ? options.parentSelection?.model.key
      : undefined) ??
    options.compactSelection?.model.key ??
    options.querySelection?.key ??
    agentDefaults?.key ??
    options.parentSelection?.model.key ??
    options.config?.getModel() ??
    '';
  return createQueryStream(options, initialModel);
}
```

它干了两件事，都在「进入事件流之前」：

1. **参数校验**（:54-56）：`compactSelection` 只能配 `modelPurpose: 'compact'`。
   这是个断言，防的是调用方把「压缩用的模型选择」塞进普通查询。
2. **算出初始模型**（:72-83）：一串 `??` 兜底，优先级从高到低是
   fork/side_question 继承父选择 → 压缩选择 → 显式 querySelection →
   Agent 默认 → 父选择 → config 兜底 → 空串。

算完之后，`query()` 就退场了。它不持有状态、不循环、不碰工具。

函数签名值得单独看一眼：`AsyncGenerator<QueryEvent, Terminal>`。它**产出**事件流，
**返回**一个 `Terminal`。调用方用 `for await` 消费事件，循环结束后拿到终止原因。
这是「一个 query 就是一段可迭代的事件序列」的直白表达。

### 文件头自己写的定位

<!-- file: qwen-code-1.0.0-preview/packages/core/src/core/agent-loop.ts:8-15 -->
```ts
/**
 * query — one prompt and the tool calls, hooks and continuations it causes.
 *
 * Execution is event driven: a session event bus routes events between the
 * Conversation, Llm and Tool handlers (see ../event-bus/), and query() only
 * listens. It yields the durable messages and runtime events of the query and
 * returns its Terminal. Prediction forks take their own single-response path.
 */
```

`query() only listens`——四个字概括了架构选择。真正干活的是三个 handler，
`query()` 只是把它们的产出接成一条调用方看得见的流。

## 二、总线的 148 行

`event-bus/bus.ts` 全文 148 行，核心是两个方法：`subscribe` 与 `publish`。
类注释交代了契约（:39-45）：

<!-- file: qwen-code-1.0.0-preview/packages/core/src/event-bus/bus.ts:39-48 -->
```ts
/**
 * Delivery only: routes by queryId, never touches query state.
 *
 * Events for one subscriber and one query are delivered serially in publish
 * order; different queries never block each other. A listener that throws or
 * rejects is reported as `handler.failed`.
 */
export class QueryEventBus {
  private readonly subscriptions = new Set<Subscription>();
  private readonly chains = new Map<string, Promise<void>>();
```

三句话，三个硬约束：

| 约束 | 含义 | 为什么重要 |
|---|---|---|
| **只做投递** | 按 `queryId` 路由，不碰查询状态 | 总线不会成为第二个真相源 |
| **同订阅同查询串行** | 一条订阅的同一 query 按 publish 顺序投递 | 事件顺序确定，handler 不用自己排 |
| **不同查询互不阻塞** | 另一个 query 的事件不会被卡住 | 子 Agent 并发不会拖慢主查询 |

### 订阅：一个回调 + 一份退订

<!-- file: qwen-code-1.0.0-preview/packages/core/src/event-bus/bus.ts:50-67 -->
```ts
  subscribe(
    source: HandlerName,
    types: readonly QueryBusEventType[],
    listener: Listener,
    options: SubscribeOptions = {},
  ): () => void {
    const subscription: Subscription = {
      name: options.name ?? source,
      source,
      types: new Set(types),
      queryId: options.queryId,
      listener,
    };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }
```

返回的是**退订函数**而不是订阅句柄。这个选择让清理变得不可能出错：
`const off = bus.subscribe(...)` 然后 `off()`，没有 id 查找，没有泄漏。

`options.queryId` 是个关键的可选过滤：给了就只收这个 query 的事件。
`queryName` 默认取 `source`（handler 名），但可以覆盖——
`QueryListener` 就用了 `query:${queryId}` 作为名字（后文会看到）。

### 发布：三道过滤 + 一次投递

<!-- file: qwen-code-1.0.0-preview/packages/core/src/event-bus/bus.ts:69-84 -->
```ts
  publish<T extends QueryBusEventType>(input: PublishInput<T>): void {
    const event = {
      ...input,
      eventId: input.eventId ?? randomUUID(),
    } as AnyBusEvent;
    for (const subscription of this.subscriptions) {
      if (!subscription.types.has(event.type)) continue;
      if (
        subscription.queryId !== undefined &&
        subscription.queryId !== event.queryId
      ) {
        continue;
      }
      this.deliver(subscription, event);
    }
  }
```

`publish` 是**同步**的——它返回 `void`，不等任何 handler 跑完。
投递本身是异步的，但调用方不被阻塞。这是事件驱动的关键：
发布者不知道也不关心有几个订阅者、它们要跑多久。

过滤只做两件事：**类型匹配**、**queryId 匹配**。没有优先级，没有中间件链，
没有「先注册先执行」以外的语义。少即是多。

### 投递：用 Promise 链排队

这是全文件最精巧的 15 行：

<!-- file: qwen-code-1.0.0-preview/packages/core/src/event-bus/bus.ts:114-128 -->
```ts
  private deliver(subscription: Subscription, event: AnyBusEvent): void {
    const key = `${subscription.name}\u0000${event.queryId}`;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await subscription.listener(event);
      } catch (error) {
        this.reportFailure(subscription.source, event, error);
      }
    });
    this.chains.set(key, next);
    void next.then(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }
```

逐行拆：

- `key = name + \u0000 + queryId`：用 NUL 字符分隔，避免名字里含分隔符时撞车。
  一个订阅 + 一个查询 = 一条独立的串行链。
- `previous = chains.get(key) ?? Promise.resolve()`：取出这条链上一次的尾巴。
- `next = previous.then(...)`：把本次投递**接到尾巴后面**。
  `@` 于是同一 key 的事件严格按 publish 顺序执行，不需要锁、不需要队列数据结构。
- `chains.set(key, next)`：更新尾巴。
- 尾部清理：只有当自己仍是尾巴时才删，避免误删后来者的链。

这三行合起来实现了「每个 key 一条串行队列，不同 key 并行」。用的是 Promise 链，
不是 `async` 队列，也不是 Mutex——**零依赖、零锁**。

### 失败不吞，转成事件

<!-- file: qwen-code-1.0.0-preview/packages/core/src/event-bus/bus.ts:86-112 -->
```ts
  /** Report a failure of work a listener started but did not await. */
  reportFailure(
    source: HandlerName,
    event: AnyBusEvent,
    error: unknown,
  ): void {
    if (event.type === 'handler.failed') {
      runLogger.warn(
        `[QueryEventBus] ${source} failed while handling handler.failed:`,
        error,
      );
      return;
    }
    this.publish({
      type: 'handler.failed',
      sessionId: event.sessionId,
      queryId: event.queryId,
      parentQueryId: event.parentQueryId,
      roundId: event.roundId,
      data: {
        source,
        eventType: event.type,
        roundId: event.roundId,
        error,
      },
    });
  }
```

handler 抛异常不会让进程崩，也不会静默消失——它变成一个 `handler.failed` 事件，
带着「谁失败了、在处理什么事件时失败、错误是什么」，重新进入总线。

递归保护（:92-98）：如果失败的事件本身就是 `handler.failed`，只打日志不再发布，
否则会无限套娃。

这个设计让**失败也是一等公民**：上层可以订阅 `handler.failed` 做降级、上报、
或像 `QueryListener` 那样把 conversation 的失败转成取消（下节会看到）。

## 三、十个事件，四个角色

`events.ts` 是总线的类型底座。`QueryBusEventMap` 定义了十个事件类型（:74-95）：

| 事件 | 发出者 | 含义 |
|---|---|---|
| `query.submitted` | Query | 查询已提交 |
| `query.output` | Query | 向上吐一个 `QueryEvent` |
| `query.cancelled` | Query | 取消，带原因 |
| `query.finished` | Query | 结束，带 `Terminal.reason` |
| `llm.request` | Llm | 请求模型，带「为什么再问一次」 |
| `llm.tool_use` | Llm | 模型返回了一个工具调用 |
| `llm.settled` | Llm | 本轮模型请求结束 |
| `tool.cancel` | Tool | 取消工具执行 |
| `tool.settled` | Tool | 一批工具执行结束 |
| `handler.failed` | 任意 | handler 抛错 |

`HandlerName` 只有四个值（:48）：`'conversation' | 'llm' | 'tool' | 'query'`。
**注意：没有 `conversation.submitted` 这类事件**——conversation 的入总是别人的出。
它是链条的起点，由 `runtime.ts` 直接拉起，不通过总线自触发。

### llm.request 带的是「为什么」

九个 `RequestReason`（:12-21）里藏着整个循环的全部出路：

```text
initial           首轮
 tool_results      上轮有工具结果要回传
escalation        模型输出被判不够，提预算重问
 stop_hook         某个 stop 钩子要求续话
truncation        输出被截断，需要续写
 malformed         模型 JSON 吐错，要求重吐
ptl               prompt too long，触发压缩后重问
reactive_compact  反应式压缩完成后重问
stream_recovery   流中断，恢复后重问
```

这就是「什么时候还要再问一次模型」的**穷举清单**。
Pi 的 `agent-loop.ts` 用 `while` 循环里的分支表达同样的东西；
Qwen 把它变成事件上的一个枚举字段。信息量一样，但**住的地方变了**：
前者住在控制流里，后者住在数据里。数据可以被记录、被断言、被订阅者按需处理。

### 事件信封不可省

<!-- file: qwen-code-1.0.0-preview/packages/core/src/event-bus/events.ts:99-110 -->
```ts
export interface BusEvent<T extends QueryBusEventType = QueryBusEventType> {
  /** Dedup key. */
  eventId: string;
  type: T;
  /** Attribution only; never a routing key. */
  sessionId: string;
  /** Routing key. */
  queryId: string;
  parentQueryId?: string;
  roundId?: string;
  data: QueryBusEventMap[T];
}
```

四个字段各司其职，注释把边界钉得很死：

- `eventId`：去重键。`publish` 里 `randomUUID()` 自动生成（bus.ts:72）。
- `sessionId`：**仅用于归因，永不作为路由键**。这是有意的——一个会话可以跑多个查询
  （子 Agent、side question），按 session 路由会让它们互相干扰。
- `queryId`：**唯一的真路由键**。
- `parentQueryId`：子查询指回父查询，用于追链。

把「归因」和「路由」拆成两件事，是这套总线能支持嵌套查询的前提。

## 四、query() 如何「只是听」

`QueryListener` 是 `query-stream.ts` 里的一个类（:48-90），它把总线上的噪声
收敛成一条调用方可消费的异步流。

### 订阅三件事，别的一概不管

<!-- file: qwen-code-1.0.0-preview/packages/core/src/event-bus/query-stream.ts:66-90 -->
```ts
    this.unsubscribe = bus.subscribe(
      'query',
      ['query.output', 'query.finished', 'handler.failed'],
      (event) => {
        if (event.type === 'query.output') {
          if (!this.closed && !this.finished) {
            this.buffer.push(event.data.event);
            this.notify();
          }
          return;
        }
        if (event.type === 'query.finished') {
          this.markFinished();
          return;
        }
        if (event.type === 'handler.failed') {
          if (event.data.source !== 'conversation') return;
          this.conversationFailure ??= { error: event.data.error };
          this.cancel('conversation_failed');
          void this.capWait().then(() => this.markFinished());
        }
      },
      { name: `query:${queryId}`, queryId },
    );
```

三路分流，各有分寸：

1. **`query.output`** → 进缓冲区 + 唤醒等待者。两个 `if` 条件是保护：
   消费者已关闭或流已结束时，后续输出直接丢弃，不再堆积。
2. **`query.finished`** → 标记结束，唤醒所有等待者退出循环。
3. **`handler.failed`** → **只认 `conversation` 的失败**，其他 handler 的失败
   各自消化，不惊动查询生命周期。conversation 挂了就意味着没人在推进对话，
   这时才转成 `query.cancelled`（reason: `conversation_failed`）。

`??=` 和 `capWait()` 两个细节：前者保证只记第一个失败（后续失败不覆盖根因）；
后者给结束加一个 10 秒上限（`CLOSE_SETTLEMENT_CAP_MS`），防止 handler 卡死时
查询永远收不了尾。

### 取消：先响信号，再发事件

<!-- file: qwen-code-1.0.0-preview/packages/core/src/event-bus/query-stream.ts:115-126 -->
```ts
  cancel(reason: QueryCancelReason, signalReason?: unknown): void {
    if (this.cancelled) return;
    this.cancelled = true;
    // Handlers read the shared signal; the event tells them it happened.
    this.state.control.abort.abort(signalReason);
    this.bus.publish(
      createBusEvent('query.cancelled', this.state.input, {
        reason,
        ...(signalReason !== undefined ? { signalReason } : {}),
      }),
    );
  }
```

注释一行抵千言：

```text
Handlers read the shared signal; the event tells them it happened.
```

**取消是双通道的**：`AbortSignal` 负责「让正在等的 IO 立刻断」，
事件负责「让 handler 知道发生了什么、为什么」。二者都不可替代：

| 只发事件 | 只 abort 信号 | 两者都要 |
|---|---|---|
| 模型请求还在飞，等不及 | handler 分不清是用户取消还是内部出错 | 信号先断 IO，事件留痕 |

这条「信号 + 事件」的双通道，是本章最值得记住的一处设计。

### 四个取消源

`QueryCancelReason` 有四个值（events.ts:23-27），对应四条不同的入口路径：

| 原因 | 谁触发的 |
|---|---|
| `abort` | 调用方发 `abort` |
| `consumer_return` | 消费者提前 `return`（`for await` 里 break） |
| `consumer_throw` | 消费者的循环体抛错 |
| `conversation_failed` | conversation handler 挂了 |

`close()` 专门处理前两种消费者侧退出（:129-135）：

<!-- file: qwen-code-1.0.0-preview/packages/core/src/event-bus/query-stream.ts:128-135 -->
```ts
  /** Consumer closed: cancel at once and drop what it will never read. */
  close(reason: QueryCancelReason): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer.length = 0;
    if (!this.finished) this.cancel(reason);
    this.notify();
  }
```

`this.buffer.length = 0` ——消费者已经不要了，缓冲区里的事件永远不会被读，
当场扔掉。这个细节区分了「暂停」和「放弃」。

## 五、三个 handler 的接力表

`runtime.ts` 只有 36 行（:20-35），把三个 handler 装到一条总线上：

<!-- file: qwen-code-1.0.0-preview/packages/core/src/event-bus/runtime.ts:20-35 -->
```ts
export function createQueryEventBus(): QueryEventRuntime {
  const bus = new QueryEventBus();
  const store = createQueryStateStore();
  const unsubscribe = [
    new ConversationHandler(bus, store).register(),
    new LlmHandler(bus, store).register(),
    new ToolHandler(bus, store).register(),
  ];
  return {
    bus,
    store,
    dispose: () => {
      for (const off of unsubscribe) off();
    },
  };
}
```

三个 handler 共享两个东西：`bus`（通信）与 `store`（状态）。它们互不引用——
ConversationHandler 的构造函数里没有 LlmHandler，反之亦然。
**它们只知道事件名**。

把三个 `register()` 里的订阅表摊开，接力关系一目了然：

| Handler | 订阅 | 发布 |
|---|---|---|
| **Conversation** | `query.submitted`、`llm.settled`、`tool.settled`、`query.cancelled`、`handler.failed` | `llm.request`、`query.output`、`query.finished` |
| **Llm** | `llm.request` | `llm.tool_use`、`llm.settled` |
| **Tool** | `llm.tool_use`、`llm.settled`、`tool.cancel`、`query.cancelled`、`handler.failed` | `tool.settled` |

### 读这张表的三个发现

**发现一：Conversation 是唯一的决策者。**
它收到 `llm.settled` 与 `tool.settled` 后，决定下一步是「再问模型」还是「结束」。
证据在 `RequestReason` 的九个值里——那些全是 Conversation 的决策结果。
Llm 和 Tool 只是执行，从不决定要不要继续。

**发现二：Llm 只订一个事件。**
`bus.subscribe('llm', ['llm.request'], ...)` ——就这一行。
Llm 不需要知道上一轮发生了什么、工具跑得怎么样，它只需要知道「去问模型」。
**这就是把「为什么问」和「怎么问」拆开的收益。**

**发现三：Tool 同时盯两个终结信号。**
`llm.settled`（本轮模型结束，工具可以开跑）+ `llm.tool_use`（单个工具调用）。
而 `tool.cancel`、`query.cancelled`、`handler.failed` 三个是它的取消与异常通道。

### 一轮的完整路径

把上面的表画成时序，一次「用户提问 → 模型调工具 → 再问模型 → 答完」的旅程：

```text
 调用方                Conversation           Llm              Tool
   │                        │                 │                 │
   │── query() ────────────>│                 │                 │
   │                        │                 │                 │
   │        ① query.submitted│                 │                 │
   │                        │──② llm.request ─>│                 │
   │                        │   (initial)     │                 │
   │                        │                 │  跑模型...      │
   │<──③ query.output ──────│                 │                 │
   │    (流式片段)          │                 │                 │
   │                        │                 │── llm.tool_use ─>│
   │                        │                 │                 │  开跑
   │                        │                 │── llm.settled ──>│
   │                        │<──── ④ tool.settled ───────────────│
   │                        │                 │                 │
   │                        │──⑤ llm.request ─>│                 │
   │                        │  (tool_results)  │                 │
   │                        │                 │  再跑模型...    │
   │                        │<─── llm.settled ──────────────────│
   │                        │                 │                 │
   │<──⑥ query.finished ───│                 │                 │
   │                        │                 │                 │
```

六步，两个环：

- **①→②**：首轮触发。Conversation 收到提交，立刻请 Llm 跑一轮。
- **③**：所有输出来自 `query.output`，由 Conversation 统一转发。
  Llm 不直接连调用方。
- **④→⑤**：**循环的那一圈**。Tool 报告跑完，Conversation 看到 `tool_results`
  这个理由，再次请 Llm。这一圈回到②就是 `while (true)` 的等价物。
- **⑥**：模型不再调工具时，Conversation 发 `query.finished`，
  带一个 `Terminal.reason` 告诉调用方为什么结束。

### 与 Pi 的双层循环对照

| | Pi（`agent-loop.ts` 960 行） | Qwen（`agent-loop.ts` 86 行） |
|---|---|---|
| 循环住在哪 | 函数里的 `while` | 事件转发的闭环（④→⑤） |
| 谁能终止 | 循环体里的 `return` | 只有 Conversation 能发 `query.finished` |
| 流式输出 | 循环体里 `yield` | `query.output` 事件 |
| 新增一个行为 | 改循环体，风险集中 | 新增订阅者，不碰已有 handler |
| 调试一个死循环 | 看栈 | 看事件序列 |

**两种方案都没错，但代价不同**：Pi 的循环一眼能读完，改起来要小心；
Qwen 的总线每块都好懂，但「整体在干什么」需要把三张订阅表拼起来才知道。
这就是本章的价值——把那张表拼出来。

## 六、工程暗坑（本章实测）

**坑一：`sessionId` 不能当路由键。**
初读 `BusEvent` 很容易把 `sessionId` 理解成默认分组依据。注释已经堵死了：
`Attribution only; never a routing key`（events.ts:103）。
一旦按 session 路由，同会话里的子 Agent 查询就会收到彼此的事件。

**坑二：`publish` 是同步的，但 handler 是异步的。**
`publish()` 返回 `void`，并不意味着 handler 已经跑完。如果你想「发一个事件然后立刻读结果」，
会读到旧值。正确方式是订阅结果事件（如 `tool.settled`）。

**坑三：`handler.failed` 有递归短路。**
`reportFailure` 发现当前事件已经是 `handler.failed` 时只打日志（bus.ts:92-98）。
这意味着：如果一个 handler 在处理失败事件时又挂了，你不会拿到第二个事件。
排查时得去看 `runLogger.warn` 的输出。

**坑四：`conversation` 失败才会结束查询。**
其他 handler 挂了只产生 `handler.failed`，查询继续。这在生产里是好事（单个工具崩了不至于全挂），
但在开发时会让「工具静默消失」变得难查——必须订阅 `handler.failed` 才能看到。

## 七、本章源码索引

| 文件 | 行数 | 一句话职责 |
|---|---|---|
| `core/src/core/agent-loop.ts` | 86 | `query()` 门面：校验参数、算初始模型、交给总线 |
| `core/src/event-bus/bus.ts` | 148 | 投递层：订阅、发布、串行链、失败转事件 |
| `core/src/event-bus/events.ts` | 115 | 类型底座：10 个事件、4 个 handler 名、9 种 request 理由 |
| `core/src/event-bus/runtime.ts` | 36 | 把一个 bus + 一个 store + 三个 handler 装起来 |
| `core/src/event-bus/query-stream.ts` | 535 | `QueryListener`：总线 → 异步流，含取消与关闭语义 |
| `core/src/event-bus/conversation-handler.ts` | 466 | 决策者：收到终结信号后决定再问还是结束 |
| `core/src/event-bus/llm-handler.ts` | 312 | 执行者：只订阅 `llm.request`，跑一轮模型 |
| `core/src/event-bus/tool-handler.ts` | 348 | 执行者：跑工具、汇总结果、发出 `tool.settled` |

## 八、自己动手验证

不需要装依赖，直接用 Node 读源码验证本章的五个断言：

```powershell
cd sources/qwen-code-1.0.0-preview

# 把下面五行存成 check.mjs，再 node check.mjs
```

<!-- file: qw-examples/check-eventbus.mjs -->
```js
import fs from 'node:fs';

const EB = 'packages/core/src/event-bus';
const len = (p) => fs.readFileSync(p, 'utf8').split('\n').length;

// 1. query() 多长？应为 86
console.log('agent-loop.ts', len('packages/core/src/core/agent-loop.ts'));

// 2. 几个事件类型？应为 10
const ev = fs.readFileSync(`${EB}/events.ts`, 'utf8');
console.log('event types', (ev.match(/^  '[a-z]+\.[a-z_]+':/gm) || []).length);

// 3. LlmHandler 订阅什么？应只有 llm.request
const llm = fs.readFileSync(`${EB}/llm-handler.ts`, 'utf8');
console.log('llm subscribes', llm.match(/subscribe\([\s\S]*?\]/)[0].trim());

// 4. bus.ts 用锁了吗？应输出 false
const bus = fs.readFileSync(`${EB}/bus.ts`, 'utf8');
console.log('uses lock', /Mutex|Semaphore|new Lock/.test(bus));

// 5. runtime 装几个 handler？应为 3
const rt = fs.readFileSync(`${EB}/runtime.ts`, 'utf8');
console.log('handlers', (rt.match(/new (\w+)Handler/g) || []).length);
```

## 九、下一步

本章只讲了「事件怎么走」，没讲「事件里到底装了什么」。
下一章 Q04 拆 `conversation-handler.ts`（466 行）：
它收到 `llm.settled` 后，到底靠什么判断该 `tool_results` 还是 `finished`？
`query-turn.ts` 与 `turn-budget.ts` 各管什么？

---

> **本章读完你应该能回答**：
> ① 为什么 `query()` 只有 86 行？
>    ——它只算初始模型，循环在事件闭环里。
> ② 三个 handler 为什么不会互相堵死？
>    ——同订阅同 query 串行，不同 query 各自一条链。
> ③ 取消为什么能立刻生效？——`AbortSignal` 断 IO，事件留痕，双通道。
> ④ 谁决定「再问一次模型」？
>    ——只有 Conversation，依据是 `RequestReason` 九个值。
> ⑤ 一次对话在生产里怎么定位？
>    ——按 `queryId` 追事件序列，`parentQueryId` 追嵌套。
