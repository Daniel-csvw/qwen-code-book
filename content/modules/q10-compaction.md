---
title: "记忆压缩 —— 14 种失败原因与一道熔断"
order: 10
part: "Part C · 上下文与资产"
eyebrow: "Q10"
meta: "1,651 字 · 108 行代码 · 12 块 · 约 15 分钟"
status: sample
snapshot: "1.0.0-preview @ 2026-11-12"
---

Q05 讲到 `assembleRequest` 第 5 步会调 `compressionPipeline.compress()`，
但没讲它内部怎么工作。本章补上。

压缩是 Agent 里最容易「看起来简单、做起来遍地坑」的部分：
调用模型总结历史、替换历史、继续对话。
难点全在失败路径——压缩失败该怎么办？

## 一、14 种失败原因

`CompactionFailureReason`（`packages/core/src/compression-v2/types.ts:108-122`）
是一份 14 项联合：

```ts
export type CompactionFailureReason =
  | 'provider_error'
  | 'provider_access'
  | 'cancelled'
  | 'empty_summary'
  | 'reasoning_only'
  | 'media_too_large'
  | 'prompt_too_long'
  | 'quota_exhausted'
  | 'auth_error'
  | 'model_queued'
  | 'rate_limited'
  | 'server_error'
  | 'network_error'
  | 'local_error';
```

14 种，按性质分三组：

| 组 | 原因 | 能不能重试 |
| --- | --- | --- |
| 内容问题 | `empty_summary` `reasoning_only` `media_too_large` | 不一定 |
| 容量问题 | `prompt_too_long` | 能（截断后） |
| 外部问题 | 其余 10 种 | 看具体 |

`empty_summary` 和 `reasoning_only` 这两个最特别：
模型返回了，但**摘要内容和空的一样**。
前者是完全没输出，后者只输出了思考过程没有正文。
压缩模型的输出不能直接信任，必须校验。

## 二、三种失败是「阻断性」的

`BlockingCompactionFailureReason`（`:134-137`）从 14 种里挑出 3 种：

```ts
export type BlockingCompactionFailureReason = Extract<
  CompactionFailureReason,
  'quota_exhausted' | 'auth_error' | 'local_error'
>;
```

为什么是这三个？因为它们的共同点是**重试没有意义**：

- `quota_exhausted` —— 配额用完了，再试还是用完；
- `auth_error` —— 鉴权失败，配置问题；
- `local_error` —— 本地逻辑异常，重试必现。

其余 11 种都可能是一次性抖动，值得再试。

而这里有一个非常漂亮的类型技巧（`:139-152`）：

```ts
/**
 * Runtime membership table for {@link
 * BlockingCompactionFailureReason}. Typed as
 * an exhaustive `Record` so adding a blocking reason to the union above is a
 * compile error here until it is listed — the breaker can never silently
 * mis-count a new blocking reason as a retry strike.
 */
const BLOCKING_COMPACTION_FAILURE_REASONS: Record<
  BlockingCompactionFailureReason,
  true
> = {
  quota_exhausted: true,
  auth_error: true,
  local_error: true,
};
```

`Record<BlockingCompactionFailureReason, true>` 是**穷尽类型**。
如果以后往联合体里加一个值（比如 `model_gone`），
这个 `Record` 就少一个键——**TypeScript 立刻报编译错误**。

注释解释了为什么必须这样：

> the breaker can never silently mis-count a new blocking reason as a retry strike.

「熔断器永远不会把新的阻断原因悄悄算成一次可重试的失败」。

这是个值得抄的模式：**用类型系统保证运行时表与类型联合同步**。
比写一个测试靠谱，因为漏写测试太容易了。

## 三、熔断器的作用域

`AutoCompactTrackingState`（`:163-180`）的注释说明了熔断器的范围：

```ts
 * This state deliberately lives outside
 * {@link CompressionPipelinePersistedState}:
 * the breaker protects repeated attempts inside one
 * user query, not future turns or resumed sessions.
```

**熔断器不落盘。** 它只保护「一次用户查询内的重复尝试」。

这个设计很关键。如果熔断状态持久化，一次配额耗尽的失败
会让后续所有会话都无法压缩——即使配额已经恢复。
限定在单次查询内，下一个查询会重新给机会。


## 四、compress 的外层：usage 聚合

`compress`（`packages/core/src/compression-v2/pipeline.ts:259-332`）74 行，
外层只做一件事：**把可能的多段压缩 usage 合并成一条**。

```ts
const recordUsage = (next: CompressionUsagePayload) => {
  if (!compactUsage) {
    compactUsage = next;
    return;
  }
  const credits = compactUsage.usage.credits;
  const nextCredits = next.usage.credits;
  compactUsage = {
    ...compactUsage,
    modelRequestIds: [
      ...new Set([...compactUsage.modelRequestIds, ...next.modelRequestIds]),
    ],
    usage: {
      ...addAnthropicUsage(compactUsage.usage, next.usage),
      ...(credits !== undefined || nextCredits !== undefined
        ? { credits: (credits ?? 0) + (nextCredits ?? 0) }
        : {}),
    },
  };
};
```

三段处理：

- `modelRequestIds` —— 用 `Set` 去重后合并；
- `usage` —— `addAnthropicUsage` 累加 token；
- `credits` —— 单独累加（可选字段，两个都空就不写）。

为什么要聚合？因为压缩可能分多段（分段压缩、fork 压缩）。
每一段都消耗 token，但用户只看到「这次压缩花了多少」。

失败路径也不忘上报（`:295-297`）：

```ts
if (compactUsage) {
  coreEvents.emit(CoreEvent.CompressionUsage, compactUsage);
}
```

**压缩失败也要报 usage。** 因为失败前可能已经调了几次模型，
钱已经花了。不报就是账目丢失。

## 五、边界写入

成功路径里有一段（`:314-328`）：

```ts
stampBoundaryDuration(result, Date.now() - compressionStartedAt);
if (compactUsage) {
  const boundary = result.newHistory?.[0];
  if (
    result.info.compressionStatus === CompressionStatus.COMPRESSED &&
    boundary?.type === 'system' &&
    boundary.subtype === 'compact_boundary'
  ) {
    boundary.compactUsage = compactUsage.usage;
    boundary.modelRequestIds = compactUsage.modelRequestIds;
    boundary.agentId = compactUsage.agentId;
  } else {
    coreEvents.emit(CoreEvent.CompressionUsage, compactUsage);
  }
}
```

压缩后的历史**第一条**是 `compact_boundary` 消息（系统类型）。
usage 挂在这条消息上，而不是单独发事件。

好处是：历史落盘后，读回来的人能知道「这个边界花了多少 token」。
如果只发事件，事件丢了就查不到了。

注意那个 `else` 分支：不满足条件时退回发事件。
两种上报路径二选一，不重复。

## 六、压缩后的历史长什么样

综合 Q06 讲的压缩分区规则，压缩后的历史结构：

```text
[system: compact_boundary]      <- 带 usage
[system: 摘要内容]
[user/assistant: 保留的尾部...]
```

Q06 的 `normalizeMessagesForAPI` 会把它切回三个区
（prefix / 摘要边界 / body）分别归一化。
所以压缩产物的**顺序是硬约束**：边界必须在最前。

## 七、触发时机与阈值分桶

`auto-compact.ts`（285 行）里有两个分桶函数，
用来把连续值映射成离散标签做统计（`:26-38`）：

```ts
function formatUsageBucket(tokenCount: number, threshold: number): string {
  if (threshold <= 0) {
    return 'threshold-floor';
  }

  const percent = (tokenCount / threshold) * 100;
  if (percent < 50) return 'lt_50%';
  if (percent < 75) return '50_75%';
  if (percent < 90) return '75_90%';
  if (percent < 100) return '90_100%';
  if (percent < 110) return '100_110%';
  return 'gte_110%';
}
```

七桶。前五桶都在 110% 以下——也就是说**允许超阈值两次**：
一次在 90-100%（该压了），一次在 100-110%（已经超了）。

为什么不压得刚好？因为 token 估算是近似值。
宁可超一点再压，也不要频繁压缩（每次压缩都要花一次模型调用）。

`formatReductionBucket`（`:40-55`）同理，六桶：

```ts
if (reductionRatio <= 0) return 'none';
if (reductionRatio < 0.25) return 'lt_25%';
if (reductionRatio < 0.5) return '25_50%';
if (reductionRatio < 0.75) return '50_75%';
return 'gte_75%';
```

`none` 这一桶很关键——压缩比率 ≤ 0 意味着**压缩没减小历史**。
这种情况要单独统计，因为它说明压缩策略失效了，
但流程上又不能算失败（模型确实返回了摘要）。


## 八、工程暗坑

**1. 压缩失败不能污染历史**
`compressImpl` 抛异常时，外层直接 `throw`（`:312`），
调用方（Q05 的 `assembleRequest`）不捕获。
所以 `pipeline.compress` 抛错会导致整轮请求失败。
这是设计选择：压缩失败通常意味着「连最便宜的模型都调不通」，
继续发原请求大概也会失败。

**2. `empty_summary` 必须判**
压缩模型返回空字符串时，如果直接当成功处理，
历史会被替换成一条空摘要——**上下文全丢**。
所以 `empty_summary` 是独立的失败原因。

**3. `reasoning_only` 同理**
只输出思考、没有正文，等于没摘要。
不判的话会把思考当摘要塞进历史，污染上下文。

**4. `credits` 累加要处理 undefined**
`(credits ?? 0) + (nextCredits ?? 0)` 且外层只在一个非空时才写。
漏判会让 `credits` 从「没有该字段」变成「0」，
下游区分不出「没计费」和「计费 0」。

**5. 熔断状态不落盘是刻意的**
不要为了「记住上次失败」把它写进 session 存储。
那会让一次临时故障永久降低压缩能力。

**6. 边界消息必须是 system 类型**
`:316-321` 的三个条件是 `type === 'system'` 且
`subtype === 'compact_boundary'`。
改成别的类型，Q06 的分区归一化就找不到边界了。

## 九、本章源码索引

| 文件 | 行数 | 本章用到的位置 |
| --- | --- | --- |
| `packages/core/src/compression-v2/types.ts` | 290 | `:108-122` 14 种失败 |
| | | `:134-152` 阻断子集与穷尽 Record，`:163-180` 熔断状态 |
| `packages/core/src/compression-v2/pipeline.ts` | 738 | `:259-332` compress |
| `packages/core/src/compression-v2/auto-compact.ts` | 285 | `:26-55` 分桶函数 |
| `packages/core/src/compression-v2/fork-compact.ts` | 740 | fork 压缩 |
| `packages/core/src/compression-v2/post-compact-finalize.ts` | 823 | 压缩后收尾 |
| `packages/core/src/compression-v2/apply-post-compact.ts` | 436 | 应用压缩结果 |
| `packages/core/src/compression-v2/ptl-retry.ts` | 417 | 超长重试 |
| `packages/core/src/compression-v2/tool-result-budget.ts` | 403 | 工具结果预算 |
| `packages/core/src/compression-v2/compact-utils.ts` | 313 | 压缩工具 |

## 十、自己动手验证

```bash
node qw-examples/check/10-compression.mjs
```

预期输出：

```text
failure reasons: 14
blocking reasons: 3
usage buckets: 7
reduction buckets: 6
exhaustive record: true
breaker persisted: false
  290 compression-v2/types.ts
  738 compression-v2/pipeline.ts
  285 compression-v2/auto-compact.ts
  740 compression-v2/fork-compact.ts
```

改一处试试：往 `CompactionFailureReason` 里加一个
`'model_gone'`，但**不**更新 `BLOCKING_COMPACTION_FAILURE_REASONS`。
`tsc` 什么都不会报——因为 `'model_gone'` 不在阻断子集里，无需入表。

再试试把它加进 `BlockingCompactionFailureReason` 却不更新 Record：
这时编译立刻失败。这就是那个类型技巧的实际效果。

## 十一、下一步

上下文与压缩讲完了。接下来的问题是：
**技能（Skill）和插件怎么挂进这套上下文？**
它们不是工具，也不是记忆，但有自己的一套加载与激活流程。
下一章 Q11 拆 `skills/` 与插件装载链路。

---

> **本章读完你应该能回答**：
> ① 压缩失败有几种原因？哪几种不该重试？
>    ——14 种；`quota_exhausted` / `auth_error` / `local_error` 三种。
> ② 为什么用 `Record<Union, true>` 而不是数组？
>    ——联合体加值时不更新就会编译失败，保证运行时表不漏项。
> ③ 熔断器为什么不落盘？
>    ——只保护单次查询，避免一次临时故障永久降低能力。
> ④ 压缩失败还要不要报 usage？
>    ——要，失败前可能已经调过模型，钱已经花了。
> ⑤ `empty_summary` 为什么不并进 `provider_error`？
>    ——它意味着上下文全丢，必须单独识别与处理。
