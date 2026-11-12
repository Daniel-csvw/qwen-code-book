---
title: "实战二：写一个钩子——三道拦截"
order: 16
part: "Part E · 实战拓展"
eyebrow: "Q16"
meta: "1,701 字 · 31 行代码 · 9 块 · 约 14 分钟"
status: sample
snapshot: "1.0.0-preview @ 2026-11-12"
---

Q08 讲了钩子的 29 个事件与 5 种实现，但没有写一个真的。
本章写三个，覆盖三种典型用途：**拦截、改参、审计**。

## 一、钩子的输出契约

钩子能做什么，全看它返回什么。
`hookOutputSchema.ts` 用 zod 给每个事件定义了专属字段。
`PreToolUse` 的最完整（`packages/core/src/hooks/hookOutputSchema.ts:39-45`）：

```ts
const preToolUseSpecific = z.object({
  hookEventName: z.literal('PreToolUse'),
  permissionDecision: permissionBehaviorSchema.optional(),
  permissionDecisionReason: z.string().optional(),
  updatedInput: z.record(z.unknown()).optional(),
  additionalContext: z.string().optional(),
});
```

`permissionDecision` 四个值（`:33`）：

```ts
const permissionBehaviorSchema = z.enum(['allow', 'deny', 'ask', 'defer']);
```

四个值的含义：

| 值 | 含义 |
| --- | --- |
| `allow` | 直接放行，不必再问 |
| `deny` | 直接拒绝 |
| `ask` | 请用户确认（Q08 讲过的模式层会再判） |
| `defer` | 交给后面的判定，自己不表态 |

`defer` 这个值最容易被忽略，但很重要：**不表态也是一种表态**。
用一个 `ask` 覆盖掉别的钩子的 `allow`，是常见的错误。
不确定时用 `defer`。

## 二、第一个钩子：拦截危险命令

目标：`Shell` 工具里出现 `rm -rf /` 之类的命令，直接 `deny`。

钩子可以写成外部脚本（`command` 型）或进程内函数（`runtime` 型）。
外部脚本的形态是这样——它从 stdin 收 JSON，往 stdout 写 JSON：

```json
{
  "hookEventName": "PreToolUse",
  "permissionDecision": "deny",
  "permissionDecisionReason": "rm -rf on root"
}
```

关键在**只写这三个字段**。不写 `updatedInput`，不改参数；
不写 `additionalContext`，不加消息。
字段越少，影响面越小。

这里有个容易踩的坑：`deny` 的 `permissionDecisionReason` 会显示给用户。
所以它要写「为什么拒」，不是「你违反了哪条规则」。
前者用户看懂就改了，后者用户还得去查规则。

## 三、第二个钩子：改参数

`updatedInput` 是 `PreToolUse` 独有的能力——**在参数到达工具之前改掉它**。

典型用途：把所有相对路径补成绝对路径。
或者把某个字段的值做规范化（比如统一成小写）。

但要注意 Q08 讲的一个关键点：
用户改了输入之后，权限判定会**用新输入复查**（`tool-check.ts:196`）。
所以钩子改参数，等于让权限系统重新判一次。
这是好事——改了参数就该重新审核。
但如果钩子的改动很小（比如只是 trim 空格），
就会白白多跑一次判定。


## 四、第三个钩子：审计日志

用 `PostToolUse` 记每一笔调用。这个事件能返回的字段（`:47-52`）：

```ts
const postToolUseSpecific = z.object({
  hookEventName: z.literal('PostToolUse'),
  additionalContext: z.string().optional(),
  updatedToolOutput: z.unknown().optional(),
  updatedMCPToolOutput: z.unknown().optional(),
});
```

四个字段，注意**没有 `permissionDecision`**。
工具已经执行完了，再判权限没有意义。

审计日志最简单的做法：**返回空对象**。
钩子不表态、不注上下文、不改输出，只是把审计写进自己的日志文件。

```json
{}
```

这是最安全的钩子——对主流程零影响。
很多团队一开始就把所有审计钩子写成「返回空对象 + 外部写文件」，
后来才逐步加 `additionalContext`。

`updatedToolOutput` 与 `updatedMCPToolOutput` 分开是 Q07 讲过的原因：
MCP 工具的返回结构跟内置工具不同，改写的形状也不同。

## 五、五个事件的字段对比

把三个钩子涉及的事件字段列出来对比，能看出设计意图：

| 事件 | 权限裁决 | 改参数 | 注上下文 | 改输出 |
| --- | --- | --- | --- | --- |
| `PreToolUse` | 有 | 有 | 有 | 无 |
| `PostToolUse` | 无 | 无 | 有 | 有 |
| `PostToolUseFailure` | 无 | 无 | 有 | 无 |
| `UserPromptSubmit` | 无 | 无 | 有 | 无 |
| `SessionStart` | 无 | 无 | 有 | 无 |

规律：**裁决只在 `PreToolUse`**，**改输出只在 `PostToolUse`**。
四个事件共享 `additionalContext`——这是最通用的能力。

`PostToolUseFailure` 没有改输出的字段，因为工具失败了没有输出可改。
但它能在失败时注入上下文——这比在后置钩子里自己判 `is_error` 干净。

## 六、钩子链：谁先谁后

一个事件可以挂多个钩子。`hookAggregator.ts`（381 行）负责合并结果，
`hookPlanner.ts`（423 行）负责排顺序。

两个文件加起来 800 行，说明「多钩子怎么合并」本身就是个不小的问题。
核心冲突是：两个钩子给出不同的 `permissionDecision`，听谁的？

`hookAggregator.ts:195` 那行注释直接给出了答案：

```ts
// Decision priority: deny > ask > allow > undefined
if (effectiveDecision === 'deny') {
```

**合并规则不是「最后一个赢」，而是「最严格的赢」**。
`deny` > `ask` > `allow` > `undefined`（弃权）。

这个规则符合安全直觉：三个钩子有一个说不行，就不行。
第 208 行的注释还补了一句：

```ts
// Weakest signal — does not override deny or ask.
```

「最弱的信号」无法覆盖 deny 或 ask。
所以 `allow` 永远不会把 `ask` 降级成放行。

## 七、工程暗坑

**1. `deny` 之后不要再写别的字段**
写了 `updatedInput` 也是白费——工具根本不会执行。
而且可能误导排查的人以为参数被改了。

**2. `additionalContext` 会进上下文，要节制**
Q10 讲过压缩的 14 种失败，其中 `prompt_too_long` 就是上下文爆了。
每次工具调用都注 1000 字，十次工具就一万字。

**3. 外部脚本的退出码也参与判定**
Q08 讲过 `command` 型钩子跑子进程。
非零退出码通常被视为「钩子失败」，行为取决于事件——
不要在脚本里用 `exit 1` 表达「拒绝」，要用 JSON 里的 `deny`。

**4. 钩子里的 `toolName` 是模型侧名字**
Q07 讲过 MCP 工具的名字是 `mcp__server__tool` 形式。
按名字匹配 MCP 工具要用全名，不能用短名。

**5. `PostToolUse` 不要做耗时操作**
它卡在「工具完成」与「模型继续」之间。
写日志要异步，不要 `await fs.writeFile`。

**6. 钩子失败不该中断对话**
Q08 讲的 `fireStopFailureSafely` 就是这个意思。
审计钩子挂了，对话该继续——日志缺失比对话中断好。


## 八、本章源码索引

| 文件 | 行数 | 本章用到的位置 |
| --- | --- | --- |
| `packages/core/src/hooks/hookOutputSchema.ts` | 418 | `:25-33` 裁决枚举
| | | `:39-52` Pre/Post 字段定义 |
| `packages/core/src/hooks/hookAggregator.ts` | 381 | `:70-82` fail-closed deny
| | | `:190-208` 合并优先级 |
| `packages/core/src/hooks/hookPlanner.ts` | 423 | 钩子链排序 |
| `packages/core/src/hooks/types.ts` | 1,865 | `:41-70` 29 个事件
| `packages/core/src/hooks/hookRunner.ts` | 2,602 | 钩子执行 |
| `packages/core/src/permissions/manager/tool-check.ts` | 411 | `:196` 改参后复查 |

## 九、自己动手验证

```bash
node qw-examples/check/16-hooks.mjs
```

预期输出：
```text
permission decisions: 4 -> allow / deny / ask / defer
preToolUse fields: 5 -> hookEventName, ... , additionalContext
postToolUse fields: 4 -> hookEventName, ... , updatedMCPToolOutput
postToolUse has permissionDecision: false
decision priority: deny > ask > allow > undefined
hook events: 29

   418 packages/core/src/hooks/hookOutputSchema.ts
   381 packages/core/src/hooks/hookAggregator.ts
   423 packages/core/src/hooks/hookPlanner.ts
```

改一处试试：写两个 `PreToolUse` 钩子，一个返回 `allow`，一个返回 `ask`。
然后执行一个需要权限的工具。
结果仍然是弹窗（ask）——因为 `allow` 是最弱信号，不能降级 `ask`。
把 `ask` 改成 `defer` 再试，就会直接放行。

## 十、下一步

工具和钩子都写完了。下一个拓展点是**技能**——
把常用流程打包成可复用的提示词模板，带上动态的上下文。
下一章 Q17 写一个技能：收版本号、跑测试、生成变更摘要。

---

> **本章读完你应该能回答**：
> ① `permissionDecision` 四个值分别是什么意思？
>    ——`allow` 放行、`deny` 拒绝、`ask` 问用户、`defer` 弃权。
> ② 多个钩子冲突时听谁的？
>    ——`deny > ask > allow > undefined`，最严格的赢。
> ③ 钩子改参数会有什么副作用？
>    ——权限判定会用新参数再跑一次复查。
> ④ 审计钩子最安全的写法是什么？
>    ——`PostToolUse` 返回空对象 `{}`，只写外部日志。
> ⑤ 为什么 `PostToolUse` 没有 `permissionDecision`？
>    ——工具已执行完，再判权限没有意义。
