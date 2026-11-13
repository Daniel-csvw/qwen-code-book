---
title: "消息协议 —— 七种消息如何投影成一次请求"
order: 6
part: "Part B · 内核"
eyebrow: "Q06"
meta: "1,674 字 · 84 行代码 · 13 块 · 约 14 分钟"
status: sample
snapshot: "1.0.0-preview @ 2026-11-12"
---

Q05 结尾留了个黑箱：`normalizeMessagesForAPI`。
本章打开它。

核心问题是：**内部为什么不能直接用 provider 的格式？**
答案藏在 `packages/core/src/protocol/transcript/message.ts` 的首行注释里（`:89`）：

```ts
/** 稳定会话载荷；transcript 直接存储此形状，不随推理契约变化。 */
export interface AssistantMessagePayload {
```

关键在「不随推理契约变化」。
会话历史要落盘、要跨版本读回、要被压缩和重放——
而 provider 的请求格式每换一个模型就可能变。
两者必须解耦，中间就是要一层投影。

## 一、七种消息

`Message` 联合体（`packages/core/src/protocol/transcript/message.ts:561-568`）
正好七个成员：

```ts
export type Message =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ProgressMessage
  | AttachmentMessage
  | ToolUseSummaryMessage
  | TombstoneMessage;
```

七种的分工：

| 类型 | 谁产生 | 进模型吗 |
| --- | --- | --- |
| `user` | 用户输入、工具结果 | 是 |
| `assistant` | 模型响应（按块拆） | 是 |
| `system` | 系统提示、压缩边界 | 部分（`subtype` 决定） |
| `progress` | 中间进度播报 | 否 |
| `attachment` | 附件注入（钩子、文件恢复） | 是（转 user 内容） |
| `toolUseSummary` | 工具调用摘要 | 否 |
| `tombstone` | 标记待删除的助手内容 | 否 |

`tombstone` 值得单说。它的注释（`:540-545`）写得坦白：

```ts
 * This is useful for streaming flows that may emit partial assistant content
 * before deciding it should be discarded. The type exists now so runtime and
 * transcript code can evolve without changing the message union later.
```

也就是说：这个类型当前**可能没被用到**，先占位。
因为一旦 `Message` 联合体定型，后面再加成员就要改所有 switch。
预留一个比事后改类型便宜——这是个很务实的取舍。

## 二、内容块只有四种

`ContentBlock`（`:83-87`）：

```ts
export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock;
```

四个，不多不少。注意 `RedactedThinkingBlock`——
它是「思考内容被安全策略涂黑」的占位。
有些 provider 返回思考摘要，有些返回被脱敏的标记，
两者必须都能进历史，否则回放时思考链会断。

用户消息侧的块类型是另一套（`:118-121`）：

```ts
export type ContentBlockParam =
  | TextBlockParam
  | ImageBlockParam
  | ToolResultBlockParam;
```

比较两套：助手侧有 `Thinking` 没有 `ToolResult`，
用户侧有 `ToolResult` 没有 `Thinking`。
这个不对称来自协议本身：工具结果永远以 user 角色回传。

## 三、五个 is 标志

`MessageBase` 里有五个 `is*` 布尔（`:141-149`）：

| 标志 | 含义 |
| --- | --- |
| `isMeta` | 合成消息，非真实用户/助手交互 |
| `isVisibleInTranscriptOnly` | 转录视图可见，实时视图隐藏 |
| `isVirtual` | 运行时包装，**不回传模型** |
| `isCompactSummary` | 压缩摘要边界 |
| `isCompactionPrefix` | 分段压缩保留的前缀 |

五个标志在 `normalizeMessagesForAPI` 里各司其职，最常用的三个：

- `isVirtual` —— 直接过滤掉（`:516`）；
- `isCompactSummary` + `isCompactionPrefix` —— 触发分区归一化（`:477-508`）；
- `isMeta` —— 保留，但下游按需隐藏。

## 四、七道工序

`normalizeMessagesForAPI`（`packages/core/src/protocol/provider/request-converter.ts:473-532`）
共 60 行，主体就是七个赋值：

```ts
const compactSummary = messages.find(
  (m) => m.isCompactSummary && m.isCompactionPrefix,
);
if (compactSummary) {
  // ... 分区递归，见下一节
}
const reordered = reorderRawAttachmentsForAPI(
  projectRefusalContext(messages),
);
const stripTargets = buildRawStripTargets(reordered);
const prepared = mergeAssistantFragments(
  reordered.filter(
    (msg) =>
      !msg.isVirtual &&
      !isRawApiErrorMarkerMessage(msg) &&
      (msg.type === 'user' ||
        msg.type === 'assistant' ||
        msg.type === 'attachment'),
  ),
);
const projected = filterAndConvert(
  prepared,
  stripTargets,
  options.targetCustomProviderId,
);
const normalized = mergeUserMessages(projected);
const sanitized = sanitizeImages(normalized, true);
validateImagesForAPI(sanitized);
return sanitizeErrorToolResults(sanitized);
```

七道工序，每道解决一类「历史不合协议」的问题：

| # | 工序 | 解决什么 |
| --- | --- | --- |
| 1 | `reorderRawAttachmentsForAPI` | 附件位置错乱 |
| 2 | `buildRawStripTargets` | 找出要剔掉的原始文本 |
| 3 | `mergeAssistantFragments` | 同一响应的碎片合并 |
| 4 | `filterAndConvert` | 类型转换 + 剔除 |
| 5 | `mergeUserMessages` | 相邻 user 消息合并 |
| 6 | `sanitizeImages` | 图片降级与限额 |
| 7 | `sanitizeErrorToolResults` | 错误结果清洗 |

注意 `mergeAssistantFragments` 在 `filterAndConvert` **之前**。
顺序不能反：先合并助手碎片，再转换类型，否则一个响应的多个块
会被转成多条独立消息，合并逻辑就找不到它们了。

同理 `mergeUserMessages` 必须在转换**之后**——
因为 `attachment` 是在 `filterAndConvert` 里才变成 user 消息的，
合并要等它们都变成 user 才能做。

## 五、压缩前缀为什么要分区

`normalizeMessagesForAPI` 开头那段（`:477-508`）是全函数最绕的部分。
注释解释了原因：

```ts
// A compacted session prefix is a separate user-context region. Normalize
// each region before merging users so the ordinary attachment/tool folding
// rules cannot move announcements into a retained historical tool result.
```

压缩后的历史长这样：

```text
[prefix 消息...]  [摘要边界]  [body 消息...]
```

三段要**各自归一化**，最后只做一次 `mergeUserMessages` 合并。
如果整体一起归一化，附件折叠规则可能把 prefix 里的通知
塞进 body 里的某个工具结果——历史就被改坏了。

代码先按标志把消息切成三组，再递归调自己：

```ts
return mergeUserMessages([
  ...normalizeMessagesForAPI(
    [...body.slice(0, at), ...prefix].map(unmark),
    options,
  ),
  ...normalizeMessagesForAPI(recovery.map(unmark), options),
  ...normalizeMessagesForAPI(body.slice(at).map(unmark), options),
]);
```

`unmark` 是把 `isCompactionPrefix` 清掉，避免递归里无限触发同一分支。
这是典型的「用标志做一次性入口」写法。

## 六、工具 ID 重写：为什么必须保持稳定

`ensureToolResultPairing`（`:97-168`，72 行）处理一个更隐蔽的问题：
**工具调用与结果的配对**。

三种异常各自处理：

| 异常 | 处理 | 行 |
| --- | --- | --- |
| 孤儿 tool_result（前面没有对应调用） | 丢弃 | `:106-111` |
| 同一轮内重复的 tool_use ID | 后来的丢弃 | `:121-126` |
| 跨轮重复的 ID | 重写成唯一 ID | `:127-133` |
| 调用没有结果 | 补一条 `isError: true` 占位 | `:154-163` |

第三种最关键。重写 ID 时不能随便生成新的——`makeUniqueToolUseId`
的注释（`:181-190`）说：

```ts
 * The result depends only on the history prefix already walked, so repeated
 * conversions of a growing history keep an identical prefix, preserving
 * provider prompt caching.
```

**重写结果只依赖已走过的历史前缀。** 这样同一段历史反复转换，
前缀部分永远得到相同的 ID——prompt 缓存才能命中。
如果改用随机 ID，每次请求前缀都变，缓存全失效。

`rewriteStates` 这个 Map 是为了记住「上次探到哪个后缀」，
避免每次重写都从头扫一遍碰撞区间。

## 七、工程暗坑

**1. `mergeAssistantFragments` 与 `mergeUserMessages` 不能调换顺序**
前者要看到原始 `Message` 类型，后者要看到转换后的 `ModelStreamMessage`。
调换会让助手碎片被当成多条响应，usage 重复累加。

**2. `isVirtual` 的消息绝不能进请求**
`:516` 的过滤是硬性的。`isVirtual` 表示「运行时包装」，
比如给 UI 看的进度消息，模型不该看见。
如果漏过滤，模型会收到自己没说过的话。

**3. 压缩分区递归时 `unmark` 必须做**
不做的话，递归的子调用又会命中 `compactSummary` 分支，
无限递归直到栈溢出。

**4. `SYNTHETIC_TOOL_INPUT_FIELDS` 是黑名单不是白名单**
`:544-547` 只有两个字段：

```ts
const SYNTHETIC_TOOL_INPUT_FIELDS = new Set([
  'modified_by_user',
  'ai_proposed_content',
]);
```

这是**剔除**清单，只列 UI 注入的字段。
新加 UI 字段时必须同步更新这里，否则会被当成工具参数发给模型。
`EXIT_PLAN_MODE_KEYS_TO_STRIP`（`:550-559`）列了 9 个，
`EDIT_KEYS_TO_STRIP`（`:561-564`）列了 3 个，都是同样的道理。

**5. 图片限额在 `sanitizeImages` 与 `validateImagesForAPI` 两处**
`getMaxRequestImages()`（`:1030`）给上限，`limitImagesForAPI`（`:1037`）
截断，`validateImagesForAPI`（`:969`）校验。
截断后还要校验——因为截断可能把某个工具结果的配对图片删掉，
导致结构不合法。

## 八、本章源码索引

| 文件 | 行数 | 本章用到的位置 |
| --- | --- | --- |
| `packages/core/src/protocol/transcript/message.ts` | 573 | `:83-87` ContentBlock，`:133-174` MessageBase |
| | | `:540-550` Tombstone，`:561-568` Message 联合体 |
| `packages/core/src/protocol/transcript/conversions.ts` | 445 | 消息创建与转换 |
| `packages/core/src/protocol/transcript/message-utils.ts` | 548 | 消息工具函数 |
| `packages/core/src/protocol/provider/request-converter.ts` | 1,294 | `:97-168` ensureToolResultPairing |
| | | `:473-532` normalizeMessagesForAPI，`:544-564` strip 集合 |
| `packages/core/src/protocol/provider/sse-client.ts` | 640 | SSE 流解析 |
| `packages/core/src/protocol/schemas/sdk-message.ts` | 1,554 | SDK 侧消息 schema |
| `packages/core/src/protocol/wire/control.ts` | 535 | 控制帧协议 |

## 九、自己动手验证

```bash
node qw-examples/check/06-message-protocol.mjs
```

预期输出：

```text
Message union: 7
ContentBlock: 4
is* flags: 5
pipeline steps: 7
strip sets: 4
protocol version: 1.5.0
  573 protocol/transcript/message.ts
  445 protocol/transcript/conversions.ts
  548 protocol/transcript/message-utils.ts
 1294 protocol/provider/request-converter.ts
  640 protocol/provider/sse-client.ts
 1554 protocol/schemas/sdk-message.ts
  534 protocol/wire/control.ts
```

改一处试试：把 `ensureToolResultPairing` 里的 `makeUniqueToolUseId`
换成 `randomUUID()`。
跑一次长会话（20 轮以上，中间有跨轮重复 ID 的场景），
观察 provider 返回的 `cached_tokens`：会从几千掉到 0。
这就是注释里「preserving provider prompt caching」的实测代价。

## 十、下一步

本章讲完了「历史怎么变成请求」，但请求里还有一大块没碰：**工具**。
`filterAndConvert` 只负责把 `ToolUseBlock` 转成 provider 格式，
工具本身的注册、schema、执行、结果回收是另一个子系统。
下一章 Q07 拆 `packages/core/src/tools/` 与 `tool-executor/`：
一个工具从注册到执行完毕要过几道关卡，MCP 工具又如何接进同一套。

---

> **本章读完你应该能回答**：
> ① 为什么内部消息格式不能直接等于 provider 格式？
>    ——会话要落盘、跨版本读回，而 provider 契约会变。
> ② `normalizeMessagesForAPI` 有几道工序？顺序能换吗？
>    ——七道；`mergeAssistantFragments` 必须在转换前，`mergeUserMessages` 必须在转换后。
> ③ 压缩后的历史为什么要分区归一化？
>    ——否则附件折叠会把 prefix 通知塞进 body 的工具结果。
> ④ 工具 ID 重写为什么要保持确定性？
>    ——重写结果只依赖历史前缀，才能让 prompt 缓存命中。
> ⑤ `isVirtual` 的消息为什么不能进请求？
>    ——它是运行时包装，模型不该看见自己没说过的话。
