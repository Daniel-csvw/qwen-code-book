---
title: "实战一：写一个自定义工具"
order: 15
part: "Part E · 实战拓展"
eyebrow: "Q15"
meta: "1,506 字 · 91 行代码 · 9 块 · 约 13 分钟"
status: sample
snapshot: "1.0.0-preview @ 2026-11-12"
---

从本章起进入 Part E。前面十四章在拆源码，后面五章讲**怎么拓展**。

第一个拓展点是工具——因为它最常用，也最好上手。
本章按源码给出的契约，走一遍完整流程。

## 一、先看基类的九个参数

`DeclarativeTool` 的构造函数（`packages/core/src/tools/tools.ts:318-328`）
把契约写得很清楚，每个参数都带注释：

```ts
constructor(
  readonly name: string, // 模型可见，调用时使用的 Tool 名称
  readonly displayName: string, // UI 展示名称、参数校验报错名称
  readonly description: string, // 模型可见，主 Agent 可以看到的工具描述
  readonly kind: Kind, // Tool 分类
  readonly parameterSchema: unknown, // 模型可见，工具入参 JSON Schema
  readonly isOutputMarkdown: boolean = true, // Tool 结果是否作为 markdown 渲染
  readonly canUpdateOutput: boolean = false, // 是否支持执行期间持续更新
  readonly pluginName?: string, // Tool 来源 Plugin 的可读名称
  readonly pluginId?: string, // Tool 来源 Plugin 的稳定唯一标识
) {}
```

九个参数按「谁看得见」分三组：

| 组 | 参数 | 谁能看到 |
| --- | --- | --- |
| 模型可见 | `name` `description` `parameterSchema` | 模型 |
| 用户可见 | `displayName` `isOutputMarkdown` `canUpdateOutput` | 用户 / UI |
| 系统用 | `kind` `pluginName` `pluginId` | 权限、注册表 |

`parameterSchema` 的注释值得细看：
「模型调用 Tool 后会基于 Schema 进行本地参数校验」。
也就是说，schema 不只是给模型看的提示，还是**运行时校验的依据**。
写错 schema 会让合法调用被拒。

## 二、kind 决定权限行为

`kind: Kind` 是个分类枚举，它影响两件事：

```ts
get isReadOnly(): boolean {
  return READ_ONLY_KINDS.includes(this.kind);
}

/** Override for input-dependent concurrency decisions. */
isConcurrencySafe(_input?: TParams): boolean {
  return this.isReadOnly;
}
```

`READ_ONLY_KINDS` 里的 kind 会被判为只读，而只读工具默认**并发安全**。
所以 kind 写错有两个后果：

- 写成了只读，但实际会改文件 → 并发执行时互相踩数据；
- 写成了可写，但实际只读 → 白丢并发性能。

`isDestructive`（`:360-`）是另一个钩子，默认返回什么要看实现；
如果工具会删数据，应该覆盖它。


## 三、Kind 十四种，只有三种只读

`Kind`（`packages/core/src/tools/tools.ts:1572-1587`）14 个值，
但只有两个子集是显式声明的：

```ts
// Function kinds that have side effects
export const MUTATOR_KINDS: Kind[] = [
  Kind.Edit,
  Kind.Delete,
  Kind.Move,
  Kind.Execute,
] as const;

// Function kinds that are safe to run in parallel
export const READ_ONLY_KINDS: Kind[] = [
  Kind.Read,
  Kind.Search,
  Kind.Fetch,
] as const;
```

三个只读：`read` / `search` / `fetch`。
四个会改：`edit` / `delete` / `move` / `execute`。
剩下七个（`think` / `agent` / `communicate` / `plan` / `switch_mode` /
`workflow` / `other`）既不在只读集也不在改写集——默认当成可写处理。

选 kind 的规则很简单：

- 真的不产生任何副作用 → 用 `Read` / `Search` / `Fetch`；
- 改了文件系统或跑了命令 → 用对应的 `MUTATOR_KINDS`；
- 拿不准 → 用 `Other`（保守，会被判为可写）。

## 四、build 是唯一抽象方法

继承 `DeclarativeTool` 只需要实现 `build`（`:454-457`）：

```ts
abstract build(
  params: TParams,
  context?: ToolUseContext,
): ToolInvocation<TParams, TResult>;
```

注释特别强调：

```ts
   * @param params The raw, untrusted parameters from the model.
```

**raw, untrusted** —— 原始、不可信。
所以 `build` 的职责是「校验 + 构造」，不是「执行」。
校验失败就抛异常，框架会把它转成工具错误返回给模型。

执行在 `ToolInvocation.execute` 里，而 `BaseToolInvocation`（`:190`）
已经实现了模板方法，子类只要写 `executeRaw`。
这个分工跟 Q07 讲的 `DiscoveredMCPToolInvocation` 一模一样。

`buildAndExecute`（`:467-`）是个便利方法，把两步合成一步，
主要给测试用——生产路径上 `build` 与 `execute` 是分开的。

## 五、完整骨架

把上面的契约拼起来，一个自定义工具长这样：

```ts
import { DeclarativeTool, Kind, BaseToolInvocation } from '@qwen-code/core';

interface CountLinesParams {
  path: string;
}

class CountLinesInvocation extends BaseToolInvocation<
  CountLinesParams,
  ToolResult
> {
  async executeRaw(): Promise<ToolResult> {
    const text = await readFile(this.params.path, 'utf8');
    const n = text.split('\n').length;
    return {
      llmContent: `${this.params.path}: ${n} lines`,
      returnDisplay: `${n} 行`,
    };
  }
}

export class CountLinesTool extends DeclarativeTool<
  CountLinesParams,
  ToolResult
> {
  constructor() {
    super(
      'CountLines',
      'Count Lines',
      'Count the number of lines in a text file.',
      Kind.Read,
      {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    );
  }

  build(params: CountLinesParams): CountLinesInvocation {
    if (!params.path) throw new Error('path is required');
    return new CountLinesInvocation(this, params);
  }
}
```

五处值得对照：

| 位置 | 对应契约 |
| --- | --- |
| `super(...)` 五个参数 | 前五个必需参数 |
| `Kind.Read` | 只读，可并发 |
| `parameterSchema` | 运行时校验依据 |
| `build` 里抛异常 | 校验失败的正确方式 |
| `executeRaw` | 基类模板方法的具体实现处 |


## 六、注册：registerTool 的三个前提

写完类只是第一步。要让模型看见它，必须注册（Q07 讲过的
`packages/core/src/tools/tool-registry.ts:269`）：

```ts
registerTool(tool: AnyDeclarativeTool): void
```

三个前提：

1. **名字唯一** —— `allKnownTools` 是 `Map<string, ...>`，同名覆盖；
2. **schema 合法** —— `getSchema` 时会转换成 `ModelStreamTool`，
   非法 JSON Schema 在这一步炸；
3. **清缓存** —— 注册后 `invalidateSchemaCache` 会被调用（`:444`），
   否则模型侧还拿着旧的工具清单。

第三条最容易漏。手工调 `registerTool` 后如果没看到工具生效，
八成是缓存没清。

## 七、走 MCP 还是走进程内

自定义工具两条路：

| 路径 | 做法 | 适合 |
| --- | --- | --- |
| 进程内 | 继承 `DeclarativeTool` | 需要访问内部状态 |
| MCP | 起一个 MCP 服务器 | 独立语言、独立进程、可复用 |

MCP 路线的优势在后三条：

- **语言自由** —— Python / Go / Rust 都行；
- **进程隔离** —— 工具崩了不会带崩主进程；
- **可复用** —— 同一个服务器给多个 Harness 用。

代价是 Q07 讲的三类 schema 补丁：
属性名非法、幽灵 required、类型全变字符串。
自己写服务器时，这三条最好提前避开。

## 八、工程暗坑

**1. schema 是运行时校验依据，不只是提示**
`parameterSchema` 的注释说得很明确。写宽了会放过脏数据，
写窄了会把合法调用拒掉。
最稳的写法：`required` 只列真正必需的，
可选参数一律给 `default`。

**2. `kind` 写错会破坏并发安全**
`isConcurrencySafe` 默认返回 `isReadOnly`。
一个会写文件的工具如果标成 `Kind.Read`，
同一轮里的多个调用会被并行执行，互相覆盖。

**3. `build` 里不要做 IO**
`build` 同步返回 `ToolInvocation`，不能 `await`。
它只做校验与构造。IO 放到 `executeRaw` 里。

**4. `executeRaw` 必须透传 signal**
Q07 讲过 `signal` 一路到底。自己的 IO 调用要收 signal，
否则用户取消后工具还在跑。

**5. 返回值有两个字段的分工**
`llmContent` 给模型，`returnDisplay` 给用户。
两者可以不同：前者适合机器读的结构化文本，后者适合人读的摘要。
只写一个会让另一侧体验变差。

**6. 注册顺序影响模型看到的顺序**
`sortTools` 用 `compareTools` 排序。
如果工具有依赖关系（比如 A 要在 B 之前出现），
得靠 `getToolPriority`（`:67`）而不是注册顺序。

## 九、本章源码索引

| 文件 | 行数 | 本章用到的位置 |
| --- | --- | --- |
| `packages/core/src/tools/tools.ts` | 1,609 | `:190` BaseToolInvocation
| | | `:243-300` ToolBuilder，`:306` DeclarativeTool
| | | `:318-328` 九个构造参数，`:351-360` isReadOnly / 并发
| | | `:454-470` build 与 buildAndExecute，`:1572-1602` Kind 与两个子集 |
| `packages/core/src/tools/tool-registry.ts` | 1,129 | `:269` registerTool，`:444` invalidateSchemaCache |
| `packages/core/src/tools/tool-names.ts` | 658 | `:471-525` 内置工具清单 |
| `packages/core/src/tools/tool-execution-lifecycle.ts` | 509 | 执行生命周期 |
| `packages/core/src/mcp/mcp-schema-sanitizer.ts` | 260 | MCP 三补丁 |

## 十、自己动手验证

```bash
node qw-examples/check/15-custom-tool.mjs
```

预期输出：
```text
kind values: 14
read only kinds: 3
mutator kinds: 4
ctor params: 9
abstract methods: 1
  1609 tools/tools.ts
  1129 tools/tool-registry.ts
   658 tools/tool-names.ts
```

改一处试试：把骨架里的 `Kind.Read` 改成 `Kind.Other`。
然后让模型在同一轮里发起三个 `CountLines` 调用。
执行会从并行变成串行——`isConcurrencySafe` 返回 false。
功能没问题，但一轮多文件的场景会明显变慢。

## 十一、下一步

工具写完了。下一个拓展点是**钩子**——
不改工具代码，就能在工具执行前后插入逻辑。
下一章 Q16 写一个真实的钩子：拦截危险命令、注入额外上下文、审计日志。

---

> **本章读完你应该能回答**：
> ① 自定义工具要继承什么？实现哪个方法？
>    ——`DeclarativeTool`，实现 `build`；执行写在 `executeRaw`。
> ② 14 种 Kind 里哪些算只读？
>    ——`Read` / `Search` / `Fetch` 三种；其余默认可写。
> ③ kind 写错会有什么后果？
>    ——破坏并发安全：可写工具被并行执行会互相覆盖。
> ④ `parameterSchema` 只是给模型看的提示吗？
>    ——不是，它是运行时参数校验依据。
> ⑤ 什么时候该走 MCP 而不是进程内？
>    ——需要独立语言、进程隔离或跨 Harness 复用时。
