---
title: "工具与 MCP —— 45 个内置工具如何接进同一张表"
order: 7
part: "Part B · 内核"
eyebrow: "Q07"
meta: "1,841 字 · 107 行代码 · 17 块 · 约 15 分钟"
status: sample
snapshot: "1.0.0-preview @ 2026-11-12"
---

Q05 讲了 `getToolSchemas` 从注册表取 schema，但没讲注册表里有什么。
本章打开它，同时回答另一个问题：**MCP 工具是外部进程提供的，凭什么能跟内置工具混在一张表里？**

## 一、45 个内置工具

`ALL_BUILTIN_TOOL_NAMES`（`packages/core/src/tools/tool-names.ts:471-525`）是一份常量数组。
数一下：**45 个**。

按用途分组：

| 组 | 工具 |
| --- | --- |
| 文件读写 | `Grep` `Read` `Edit` `Write` `Glob` `NotebookEdit` |
| 命令执行 | `Shell` `PowerShell` `BashInput` `BashOutput` `BashResize` `Monitor` |
| 网络 | `WebSearch` `ImageSearch` `WebFetch` |
| 生成 | `ImageGen` `VideoGen` `VideoGenRetrieve` |
| 任务 | `TaskCreate` `TaskGet` `TaskUpdate` `TaskList` `TaskStop` `CompleteTask` |
| 目标 | `GetGoal` `CreateGoal` `UpdateGoal` |
| 模式 | `EnterPlanMode` `ExitPlanMode` `EnterWorktree` `ExitWorktree` |
| 调度 | `CronCreate` `CronDelete` `CronList` `ScheduleWakeup` |
| 协作 | `Agent` `SendMessage` `ListAgents` |
| 其它 | `CodeMode` `CodeModeWait` `Skill` `AskUser` `WriteTodos` `UpdateTopic` `Workflow` |

三个细节值得注意：

**1. `Agent` 是唯一的代理入口。**
注释（`:512-514`）明确说：

```ts
// The unified Agent tool (dispatches to explore, plan, general-purpose, etc.
// via subagent_type). Individual agent names (explore, plan) are NOT
// standalone tools — they are agent definitions dispatched through the
// tools — they are agent definitions dispatched through the unified Agent
// tool's subagent_type parameter.
```

`explore`、`plan` 这些名字不是工具，是 `Agent` 工具的 `subagent_type` 参数取值。
这样一个工具就能覆盖所有类型的子代理，不用为每种代理注册一个工具。

**2. 有些工具用注释解释「为什么必须列在这里」。**
`SendMessage` 和 `ListAgents`（`:520-524`）：

```ts
// Messaging. Listed so `--tools` narrows them like any other built-in: left
// out, an empty `--tools` still handed a headless run these two and nothing
// else, and with nothing else to do the model went and messaged sessions.
```

这说的是一个 bug：不列进 `ALL_BUILTIN_TOOL_NAMES` 的工具，`--tools` 白名单就管不住它。
曾经 headless 跑 `--tools` 空列表时，模型手里只剩这两个工具，
没别的事可做，就去给别的会话发消息了。

**3. `TOOL_PRESETS` 只有一个值**（`:531`）：

```ts
export const TOOL_PRESETS = ['default'] as const;
```

`--tools` 只认 `default`，展开成「全部内置工具」。
这是个刻意的最小设计——预设多了会产生「预设与显式列表冲突」的判定难题。

## 二、ToolRegistry 的四个缓存

`ToolRegistry`（`packages/core/src/tools/tool-registry.ts:144-`，1,129 行）
是整个工具子系统的核心。它的字段里有四个缓存：

| 字段 | 键 | 作用 |
| --- | --- | --- |
| `allKnownTools` | 工具名 | 全量工具表（含未激活的） |
| `mcpModelNameIndex` | 模型侧名 | 映射到注册表规范名 |
| `schemaCache` | 模型 ID + 提示包 | 声明缓存 |
| `convertedSchemaCache` | 声明数组（WeakMap） | 转换后的 `ModelStreamTool` |

`schemaCache` 的注释（`:157-160`）说明了为什么要按「模型 ID + 提示包」做键：

```ts
// In-process cache for declarations, keyed by modelId + prompt bundle so a
// live remote-policy change cannot leave Full/Lean tool descriptions stale.
// Cleared whenever the tool set changes (register/unregister/sort/remove).
```

远程策略可以在会话中途改变（比如从 Full 切到 Lean 描述）。
如果只按模型 ID 缓存，切了策略还是拿到旧的描述。
所以键里必须带提示包，且工具集变动时要清缓存。

`getSchema`（`:185-203`）的 19 行是整章的枢纽：

```ts
getSchema(
  modelKey?: string,
  schemaContext?: FileReadRecoverySchemaContext,
): ModelStreamTool[] {
  const override = this.schemaOptions.schemaOverride;
  if (override) return [...override];
  this.applyMcpTools();
  const effectiveModel = modelKey ?? this.config.getActiveModel() ?? '';
  const declarations = schemaContext
    ? this.getModelFunctionDeclarations(effectiveModel, schemaContext)
    : this.getModelFunctionDeclarations(effectiveModel);
  const cached = this.convertedSchemaCache.get(declarations);
  if (cached) return cached;
  const filter = this.schemaOptions.schemaFilter;
  const schemas = buildModelStreamTools(declarations);
  const visible = filter ? schemas.filter(filter) : schemas;
  this.convertedSchemaCache.set(declarations, visible);
  return visible;
}
```

四条路径，优先级从上到下：

1. **`schemaOverride`** —— fork 出的子代理可以固定一套 schema，不受主注册表影响；
2. **`applyMcpTools()`** —— 每次取 schema 前同步 MCP 工具（下一节细讲）；
3. **`convertedSchemaCache`** —— 用声明数组做 WeakMap 键，命中就返回；
4. **`schemaFilter`** —— 最后再过一道过滤（比如子代理只给只读工具）。

注意第 3 步用 `WeakMap` 而不是 `Map`。声明数组是每次新建的，
用 `Map` 会永久持有引用，内存泄漏；`WeakMap` 让 GC 能回收。

## 三、MCP 工具怎么变成内置工具

## 三、MCP 工具怎么变成内置工具

关键在 `applyMcpTools()`（`packages/core/src/tools/tool-registry.ts:211-232`）：

```ts
private applyMcpTools(): void {
  const mcp = this.config.getSessionMcpManager?.();
  const plan = mcp?.getInjectedMcpTools();
  if (!mcp || !plan) return;
  this.unsubscribeMcp ??= mcp.onToolListChange(() => this.applyMcpTools());
  const next = new Set<string>();
  for (const entry of plan.tools) {
    next.add(entry.qualifiedName);
    if (this.getKnownTool(entry.qualifiedName) !== entry.tool) {
      this.registerTool(entry.tool);
    }
  }
  for (const name of this.registeredMcpTools) {
    if (!next.has(name)) this.unregisterTool(name);
  }
  if (plan.includeMetaTools) {
    this.config.registerLazyMetaTools(this);
  }
  this.sortTools();
  this.registeredMcpTools.clear();
  for (const name of next) this.registeredMcpTools.add(name);
}
```

三步：**补新增**、**删消失**、**重排序**。

这段代码揭示了 MCP 的接入方式：**MCP 工具在注册表里就是普通工具**。
`DiscoveredMCPTool`（`packages/core/src/mcp/tools/mcp-tool.ts:422`）继承自
`BaseDeclarativeTool`，跟内置工具同一个基类。

所以「内置」与「外部」的差别被完全消除——
`getSchema()` 只是从 `allKnownTools` 里取，不关心它是谁注册的。

## 四、MCP 名字的三段式

MCP 工具全名由 `buildMcpToolName` 拼出（`packages/core/src/mcp/tools/mcp-tool.ts:117-119`）：

```ts
export function buildMcpToolName(
  serverName: string,
  toolName: string,
): string {
  return (
    MCP_TOOL_PREFIX +
    normalizeMcpSegment(serverName) +
    MCP_QUALIFIED_NAME_SEPARATOR +
    normalizeMcpSegment(toolName)
  );
}
```

形如 `mcp__server__tool`。`formatMcpToolName`（`:97-111`）支持通配：

| serverName | toolName | 结果 |
| --- | --- | --- |
| `*` | 省略或 `*` | `mcp__*` |
| `*` | `read` | `mcp__*__read` |
| `filesystem` | 省略或 `*` | `mcp__filesystem__*` |
| `filesystem` | `read` | `mcp__filesystem__read` |

通配是为权限规则服务的——一条 `mcp__filesystem__*` 就能覆盖整台服务器。

## 五、三个必须打的补丁

MCP 是外部生态，schema 质量参差不齐。`mcp-schema-sanitizer.ts`（260 行）
专门收拾三种烂数据。

**补丁一：非法属性名。**
上游 API 对 `properties` 的键有硬约束（`:26`）：

```ts
export const MCP_PROPERTY_KEY_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;
```

但有些 MCP 服务器会吐出带冒号的键，比如 ComfyUI 桥接服务器
产生的 `8:BizyAir_NanoBanana2.aspect_ratio`。注释（`:12-16`）说得很清楚：
API 会直接拒掉整个请求。

`sanitizeKey`（`:53-61`）逐字符替换：

```ts
function sanitizeKey(key: string): string {
  let out = '';
  for (const ch of key) {
    out += MCP_PROPERTY_CHAR_PATTERN.test(ch) ? ch : '_';
  }
  if (out.length === 0) out = '_';
  if (out.length > MAX_KEY_LENGTH) out = out.slice(0, MAX_KEY_LENGTH);
  return out;
}
```

但改了名字之后，模型调用时用的还是新名字。
所以必须留一张反向映射表（`keyMap: Map<string, string>`），
`SanitizedMcpInputSchema` 的注释（`:40-42`）说：

```ts
 * - `keyMap` is `null` when no rewriting occurred. Otherwise it maps
 *   `sanitized → original` for the top-level properties, ready to be used by
 *   {@link restoreOriginalArgKeys}.
```

**补丁二：幽灵 required。**
有些服务器在 `required` 里列了 `properties` 中不存在的字段，
比如占位符 `//TODO: Add Field Name 0`。
严格的上游（注释点名 Moonshot/Kimi）会拒掉整个 schema（`:68-69`）：

```ts
 * (`required property ... is not defined in properties`), which breaks every
 * request in the session, so we prune those ghost entries defensively.
```

`pruneGhostRequired`（`:74-96`）只删字符串型的不存在项，
非字符串原样保留——因为非字符串本来就不合法，删了也没意义。

**补丁三：只改顶层。**
注释（`:101-105`）：

```ts
 * Only rewrites `properties` keys (and mirrors the same rewrites into the
 * `required` array). Nested `properties` inside array `items` / object
 * children are intentionally left alone — in practice the constraint is
 * enforced at the top level, and leaving nested structures untouched keeps
 * the reverse-map (and therefore the MCP call path) simple and correct.
```

嵌套结构不动，因为反向映射表要跟着嵌套走，容易出错。
而实际上 API 只在顶层校验——这是个「按实际情况裁剪」的务实选择。

## 六、参数类型强转

`executeRaw`（`packages/core/src/mcp/tools/mcp-tool.ts:290-`）开头有个细节（`:296-300`）：

```ts
// Coerce argument types based on MCP schema to handle models
// that output all parameter values as strings.
const schemaProps = (
  this.toolParameterSchema as Record<string, unknown> | undefined
)?.['properties'] as Record<string, unknown> | undefined;
```

有些模型会把所有参数都输出成字符串——`{"count": "5"}` 而不是 `{"count": 5}`。
MCP 服务器收到字符串 `"5"` 可能直接报参数类型错误。
所以这里按 schema 强转回来。

这条注释值得记住：**不要相信模型输出的类型**，schema 才是真相。

## 七、工具执行三阶段

`DiscoveredMCPToolInvocation`（`:234`）继承 `BaseToolInvocation`，
`execute()`（`:286-288`）只有一行：

```ts
async execute(signal: AbortSignal): Promise<ToolResult> {
  return this.executeRaw(signal);
}
```

为什么包一层？因为基类的 `execute` 是模板方法——
子类只实现 `executeRaw`，基类负责计时、日志、错误包装。
这是标准 Template Method，但值得指出：**`signal` 一路透传到底**，
工具自己不需要知道取消逻辑，只要把它转给 HTTP 客户端。

结果处理的链条在 `:737-886`，三个函数：

| 函数 | 作用 |
| --- | --- |
| `extractMcpErrorMessage` | 从响应里抠出错误文本 |
| `transformMcpContentToSemanticBlocks` | MCP 内容转语义块 |
| `normalizeMcpToolResult` | 归一化成 `ToolResult` |

MCP 的返回可能是文本、图片、音频、资源链接（`:591-737` 四个 transform）。
全部要转成内部统一的 `SemanticBlock`，否则上层的渲染层要认识 MCP 协议。

## 八、工程暗坑

**1. `applyMcpTools` 每次 `getSchema` 都跑**
`:191` 那行 `this.applyMcpTools()` 没有缓存判断。
靠的是内部 `getKnownTool(...) !== entry.tool` 的引用比较来做幂等。
如果 MCP 服务器每次返回新对象，就会反复注销重注册。

**2. `onToolListChange` 订阅必须 `dispose`**
`:215` 的 `this.unsubscribeMcp ??=` 保证只订阅一次，
但 `dispose()`（`:206-209`）必须被调用，否则 MCP 管理器持有注册表引用，
会话结束也回收不掉。

**3. required 镜像必须同步**
改写 `properties` 键之后，`required` 数组里对应的字符串也要改。
漏改会让新键变成「不在 required 里」，旧键变成「required 但不存在」——
等于同时触发幽灵 required 错误。

**4. 通配名不能进注册表**
`formatMcpToolName('*', '*')` 产出 `mcp__*`，这是给权限规则匹配用的。
如果真去 `registerTool('mcp__*')`，会污染 `allKnownTools`。

**5. `Skill` 工具会改 `toolUseContext`**
`packages/core/src/event-bus/conversation/tools-settled.ts:91-106` 里，
工具结果可以带 `contextModifier`：

```ts
// Tool results carry contextModifier entries (e.g. Skill activation); apply
// them in model order so overrides and overlays persist across requests.
```

`Skill` 工具通过这个机制切换模型和思考预算。
这是个隐藏的强耦合：工具不但返回结果，还能改后续请求的配置。

## 九、本章源码索引

| 文件 | 行数 | 本章用到的位置 |
| --- | --- | --- |
| `packages/core/src/tools/tool-names.ts` | 658 | `:471-525` 45 个内置工具，`:531` 预设 |
| `packages/core/src/tools/tool-registry.ts` | 1,129 | `:144-179` 字段与四个缓存 |
| | | `:185-203` getSchema，`:211-232` applyMcpTools |
| `packages/core/src/tools/tools.ts` | 1,609 | 工具基类与通用类型 |
| `packages/core/src/tools/streaming-tool-executor.ts` | 846 | 流式执行器 |
| `packages/core/src/tool-executor/state-manager.ts` | 658 | 执行状态管理 |
| `packages/core/src/tool-executor/types.ts` | 315 | 执行器类型 |
| `packages/core/src/mcp/tools/mcp-tool.ts` | 1,336 | `:97-119` 名字拼装 |
| | | `:286-300` executeRaw，`:737-886` 结果归一化 |
| `packages/core/src/mcp/mcp-schema-sanitizer.ts` | 260 | `:26` 键约束，`:53-61` sanitizeKey |
| | | `:74-96` pruneGhostRequired |
| `packages/core/src/mcp/sessionMcpManager/sessionMcpManager.ts` | 1,810 | MCP 会话管理 |
| `packages/core/src/mcp/client/mcpClient.ts` | 914 | MCP 客户端 |
| `packages/core/src/mcp/connector/connectMcpServer.ts` | 415 | 连接建立 |

## 十、自己动手验证

```bash
node qw-examples/check/07-tools-mcp.mjs
```

预期输出：

```text
builtin tools: 45
tool presets: 1
registry fields: 12
getSchema paths: 4
schema sanitizer regex: /^[a-zA-Z0-9_.-]{1,64}$/
mcp name parts: 3
  658 tools/tool-names.ts
 1129 tools/tool-registry.ts
 1336 mcp/tools/mcp-tool.ts
  260 mcp/mcp-schema-sanitizer.ts
 1810 mcp/sessionMcpManager/sessionMcpManager.ts
  914 mcp/client/mcpClient.ts
```

改一处试试：把 `applyMcpTools()` 里
`if (this.getKnownTool(entry.qualifiedName) !== entry.tool)` 的引用判断
改成永远 `registerTool`。
然后接一台 MCP 服务器，连续发 10 条消息：
`allKnownTools` 大小不变，但每次都会触发 `sortTools()` 和缓存失效，
schema 缓存命中率归零——每次请求都要重新转换整套工具定义。

## 十一、下一步

工具会执行，也可能出错、可能碰到权限、可能被钩子拦下。
本章只讲了「怎么注册和调」，没讲「谁能调、调之前要过几关」。
下一章 Q08 拆两层：**权限**（能不能做）与**钩子**（做之前要不要先问你）。
`packages/core/src/hooks/` 与权限判定链路，是产品级 Harness 与玩具实现的分水岭。

---

> **本章读完你应该能回答**：
> ① 内置工具几个？`Agent` 与 `explore` 什么关系？
>    ——45 个；`explore` 是 `Agent` 的 `subagent_type` 参数，不是独立工具。
> ② MCP 工具凭什么算「内置」？
>    ——它继承同一基类，注册进同一张表，`getSchema` 不区分来源。
> ③ 为什么 MCP schema 要改写键名？改写后怎么还原？
>    ——API 限制键名 `^[a-zA-Z0-9_.-]{1,64}$`；靠 `keyMap` 反查。
> ④ 幽灵 required 不删会怎样？
>    ——严格上游会拒掉整个 schema，此后整场会话所有请求全失败。
> ⑤ `Skill` 工具为什么能改后续请求的行为？
>    ——工具结果带 `contextModifier`，在 `handleToolResults` 里被应用。
