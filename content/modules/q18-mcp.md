---
title: "实战四：写一个 MCP 服务器"
order: 18
part: "Part E · 实战拓展"
eyebrow: "Q18"
meta: "2,203 字 · 126 行代码 · 13 块 · 约 17 分钟"
status: sample
snapshot: "1.0.0-preview @ 2026-11-12"
---

Q07 讲过一个论断：**MCP 工具和内置工具在注册表里是平级的**，
区别只在名字带 `mcp__` 前缀。本章写一个真的服务器，
把这句话验证到底。

## 一、服务器要满足的契约

MCP 是 JSON-RPC 协议。服务器不用管传输，只需回答三个问题：
**你叫什么、你有哪些工具、调用这个工具会怎样**。

在 Qwen Code 这一侧，工具的描述用 `MCPServerConfig` 配置
（`packages/core/src/mcp/mcpServerConfig.ts:40-87`）：

```ts
export class MCPServerConfig {
  constructor(
    // For stdio transport
    readonly command?: string,
    readonly args?: string[],
    readonly env?: Record<string, string>,
    readonly cwd?: string,
    // For sse transport
    readonly url?: string,
    // For streamable http transport
    readonly httpUrl?: string,
    readonly headers?: Record<string, string>,
    // For websocket transport
    readonly tcp?: string,
    readonly type?: 'sse' | 'http' | 'ws' | 'sdk',
    readonly timeout?: number,
    readonly trust?: boolean,
    readonly includeTools?: string[],
    readonly excludeTools?: string[],
    ...
  ) {}
}
```

四种传输：`stdio`（默认，走 `command`）、`sse`、`http`、`ws`，
外加一个特殊的 `sdk`——进程内桥接，不启子进程。

`includeTools` 与 `excludeTools` 是**白名单与黑名单**，
两个都写时的优先级在源码注释里写死了（`mcp-tool.ts:1325`）：

```ts
// excludeTools takes precedence over includeTools
if (excludeTools && excludeTools.includes(funcDecl.name)) {
  return false;
}
```

**黑名单优先**。先排除，再看白名单。
这个顺序符合安全直觉：拉黑是不可撤销的，白名单再多也捞不回来。

白名单还有个隐藏语法（`:1332-1333`）：

```ts
includeTools.some(
  (tool) => tool === funcDecl.name || tool.startsWith(`${funcDecl.name}(`),
)
```

注意括号是**拼在名字之后**的，所以 `includeTools` 里写 `"search"`
只匹配名字恰为 `search` 或 `search(` 开头的工具，匹配不到 `searchAll`。
它不是 glob——想做批量筛选，在配置生成阶段把名单展开成完整列表。

工具的返回形状也是契约的一部分。仓库里的测试服务器把它写成了类型
（`packages/core/src/test-utils/test-mcp-server.ts:11-25`）：

```ts
export interface TestToolResponse {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface TestTool {
  name: string;
  description: string;
  /** JSON Schema for input arguments */
  inputSchema?: Record<string, unknown>;
  response: TestToolResponse;
}
```

`content` 是个数组，元素带 `type`。`text` 只是其中一种——
还可以是 `image`、`resource`。这个「内容块数组」结构
和 Q06 的消息协议是同构的，不是巧合：MCP 与 Anthropic 的消息格式本就同源。

`isError` 是**结果级**的错误标记，不是协议级。
协议级的错误走 JSON-RPC 的 `error` 字段；
`isError: true` 表示「调用成功了，但业务上失败了」。
两者的区别在下一章 Q19 会变得关键。

## 二、工具名叫什么：`mcp__server__tool`

MCP 工具进入注册表时要改名，因为模型看到的名字必须是全局唯一的。
规则就写在 `mcp-names.ts` 的头部（`:8-9`）：

```ts
/**
 * MCP qualified-name primitives: `mcp__{server}__{tool}`.
 * ...
 */
```

前缀 `mcp__`，分隔符 `__`。所以服务器叫 `weather`、工具叫 `get_forecast`，
模型看到的是 `mcp__weather__get_forecast`。

但服务器名和工具名是**用户随手起的**，可能带空格、中文、emoji。
`normalizeMcpSegment`（`:37-47`）负责把它们压成合法段：

```ts
export function normalizeMcpSegment(segment: string): string {
  const slug = segment
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (!/[^\p{ASCII}]/u.test(segment)) return slug;

  // A pure mapping keeps IDs stable across discovery order and reconnects.
  const hash = createHash('sha256').update(segment).digest('hex').slice(0, 12);
  return `${slug || 'u'}_${hash}`;
}
```

三步清洗：非法字符换 `_`、连续 `_` 压成一个、首尾 `_` 去掉。
**为什么最后一步重要**：段与段之间用 `__` 拼。如果某段以 `_` 结尾，
拼接后就多出一个 `_`，`mcp__a___b` 这种名字拆不回来。
所以清洗必须保证段本身**不带首尾下划线**——这是为了保证分隔符可解析。

对非 ASCII 名还有一步：追加原名的 sha256 前 12 位。
注释解释了原因——「不同的中文名会被压成同一个（可能为空的）slug」。
`发布工具` 和 `发布工具2` 清洗后都是空串，没有哈希就撞名了。
哈希是**纯映射**，与发现顺序无关，重连也不会变——
否则每次重连工具名都变，prompt 缓存全废（Q06 讲过这件事）。

## 三、三补丁：让别人的 schema 能过本站的关

MCP 服务器是别人写的，schema 什么样都有。
而 Qwen Code 上游 API 对 `properties` 的键名有个硬约束
（`mcp-schema-sanitizer.ts:26`）：

```ts
export const MCP_PROPERTY_KEY_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;
```

只允许字母、数字、下划线、点、横线，最长 64。
有服务器会吐 `8:BizyAir_NanoBanana2.aspect_ratio` 这种带冒号的键
（注释里点名了 ComfyUI 系的桥接服务器），整个 schema 会被拒。

于是有了三个补丁：

**补丁 1：键名重写**（`:53-61`）。逐字符过滤，非法字符换 `_`，超长截断。
同时记一张 `sanitized → original` 的反向表。

**补丁 2：幽灵 required 剪除**（`:74-96`）。有些服务器的 `required` 里列了
`//TODO: Add Field Name 0` 这种占位名，但 `properties` 里根本没有。
严格的上游会拒绝整个 schema（`required property ... is not defined`），
于是**这一轮会话所有请求全挂**——一个工具的问题拖垮全局。
所以防御性地剪掉，并打一条 warn 记录剪了什么。

**补丁 3：只改顶层**（`:98-106` 注释）：

```ts
/**
 * Only rewrites `properties` keys (and mirrors the same rewrites into the
 * `required` array). Nested `properties` inside array `items` / object
 * children are intentionally left alone — in practice the constraint is
 * enforced at the top level, and leaving nested structures untouched keeps
 * the reverse-map (and therefore the MCP call path) simple and correct.
 */
```

不改嵌套结构，是为了让**反向映射保持简单正确**。
嵌套深了，反向映射要建树，"哪一层的这个键"就得带路径，
一处出错整个调用参数就错位。这是一个典型的「宁可少做，也要做对」。

补丁 1 埋下的表必须**有回路**。`mcp-tool.ts` 里，
`callTool` 派发前会调 `restoreOriginalArgKeys`（`:1271`）把模型给的
清洗后键名换回原名。少了这一步，服务器收到的就是 `_` 拼出来的假名字。

## 四、超时：三层，默认值很反直觉

MCP 调用有三层时间限制（`mcp-timeouts.ts:13-31`）：

| 层 | 常量 | 默认值 |
| --- | --- | --- |
| 连接/发现 | `MCP_CONNECT_TIMEOUT_MSEC` | 30,000 ms |
| 空闲 | `MCP_STDIO_TOOL_IDLE_TIMEOUT_DEFAULT_MSEC` | 1,800,000 ms（30 分） |
| 硬墙钟 | `MCP_TOOL_HARD_TIMEOUT_DEFAULT_MSEC` | 100,000,000 ms |

第三层值得停一下：一亿毫秒约等于 **27.8 小时**。
不是笔误，也不是打错了零——它的语义是「**等于不设**」。
真正的兜底交给「空闲超时」：只要工具还在吐数据，就不算超时；
一旦 30 分钟没有任何输出，认定为卡死。

这个选择对 MCP 特别合理。MCP 工具可能是训练模型、跑编译、下载大文件，
时长本身无法预估；判断「还活着吗」比判断「该不该结束」容易得多。

还有一条注释值得注意（`:16-19`）：

```ts
/**
 * Connect/discovery request timeout. Per-server `timeout` is intentionally
 * reserved for tool calls and never overrides this value.
 */
```

配置里的 `timeout` 字段**只作用于工具调用，不改连接超时**。
想调连接超时没有配置项——这是有意的：连接阶段的慢通常意味着配置写错，
让它快点失败比让它慢慢等更好。

## 五、一个最小的服务器骨架

协议细节交给 SDK，你只需要实现一个 `tools/list` 与一个 `tools/call`。
最小的 stdio 服务器大概长这样：

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  StdioServerTransport,
} from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'repo-tools', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'count_todos',
      description: 'Count TODO comments in the repo',
      inputSchema: {
        type: 'object',
        properties: { dir: { type: 'string' } },
        required: ['dir'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'count_todos') {
    throw new Error(`unknown tool: ${req.params.name}`);
  }
  const dir = String(req.params.arguments?.dir ?? '.');
  const n = countTodos(dir);
  return { content: [{ type: 'text', text: `found ${n} TODO` }] };
});

await server.connect(new StdioServerTransport());
```

三个要点：

1. **`inputSchema` 必须合法 JSON Schema**。它会进 `tools/list`，
   然后被上一节的三补丁处理一遍。所以就算你写了奇怪键名也能用，
   但别指望嵌套结构也被救。
2. **未知工具要抛错**，不要返回 `isError: true`。
   协议级错误和结果级错误的区别就在这里——服务器不认这个名字，
   这是协议错误，不是业务失败。
3. **`content` 是数组**，不是字符串。想返回图片就加
   `{ type: 'image', data: base64, mimeType: 'image/png' }`。

然后写进配置：

```json
{
  "mcpServers": {
    "repo-tools": {
      "command": "node",
      "args": [".mcp/repo-tools.js"],
      "trust": true
    }
  }
}
```

模型看到的名字是 `mcp__repo-tools__count_todos`。

## 六、工程暗坑

**1. `trust` 决定要不要问**
`trust: true` 表示这个服务器的工具默认放行。
不写它，每次调用都要过 Q08 那套权限判定。
对你自己写的、只读的服务器可以开；对外部服务器不要图省事。

**2. 服务器启动失败是静默的**
连接失败不会让对话失败，只是**这个服务器的工具都不出现**。
所以「模型说没有这个工具」时，第一步是看 MCP 的连接状态，
而不是怀疑模型。仓库里有个 `mcp-status.ts` 协议专门传这个状态。

**3. `sdk` 类型不是真服务器**
`type: 'sdk'` 的服务器跑在 SDK 进程内，每次 JSON-RPC 都通过控制协议
回传到 SDK（`mcpServerConfig.ts:104-110` 的注释）。
它不走 stdio，也不 listen 端口——排障时不要去找进程。

**4. `scope` 有五种，治理规则不同**
`user` / `local` / `project` / `flag` 是磁盘来源，受信任门控；
`dynamic` 是运行时注入（ACP 会话或控制命令），**豁免信任门控**，
只剩企业白名单。所以「为什么这个服务器的工具没经过我批准」，
先看它是不是 `dynamic`（`mcpServerConfig.ts:24-33`）。

**5. 中文服务器名会导致工具名变长**
`发布工具` 清洗成空 slug 加 12 位哈希（`u` 是空 slug 的兜底）。
这个名字会进模型上下文，既看不懂又不稳定（换名字哈希就变）。
所以自己的服务器**用英文起名**。

**6. `isError` 同时接受布尔和字符串**
`mcp-tool.ts:835`：`response.isError === true || response.isError === 'true'`。
有些服务器（尤其是 Python 写的）会把布尔序列化成字符串。
这个兼容层说明：**不要相信 MCP 服务器的类型声明**。

## 七、本章源码索引

| 文件 | 行数 | 本章用到的位置 |
| --- | --- | --- |
| `packages/core/src/mcp/mcpServerConfig.ts` | 140 | `:24-33` 五种 scope |
| | | `:40-87` 配置构造参数 |
| `packages/core/src/mcp/tools/mcp-names.ts` | 90 | `:8-9` 命名规则 |
| | | `:37-47` 段清洗与哈希 |
| `packages/core/src/mcp/mcp-schema-sanitizer.ts` | 260 | `:26` 键名正则 |
| | | `:74-96` 幽灵 required |
| | | `:98-106` 只改顶层 |
| `packages/core/src/mcp/tools/mcp-tool.ts` | 1,336 | `:835` isError 宽松判定 |
| | | `:1271` 参数反向还原 |
| | | `:1325-1335` 黑白名单优先级 |
| `packages/core/src/mcp/tools/mcp-timeouts.ts` | 183 | `:13-31` 三层超时 |
| `packages/core/src/mcp/client/mcpClient.ts` | 914 | 连接与握手 |
| `packages/core/src/test-utils/test-mcp-server.ts` | 76 | `:11-25` 返回契约 |

## 八、自己动手验证

```bash
node qw-examples/check/18-mcp.mjs
```

预期输出：
```text
transports: 4 -> sse / http / ws / sdk
server scopes: 5 -> user / local / project / flag / dynamic
tool name prefix: mcp__
separator: __
non-ascii hash length: 12
property key pattern: ^[a-zA-Z0-9_.-]{1,64}$
has pruneGhostRequired: true
request timeout: 30000 ms
hard timeout: 100000000 ms (~28h)
idle timeout stdio/remote: 1800000 / 300000 ms
```

改一处试试：把 `mcp-timeouts.ts:14` 的硬超时改成一个真实值，比如 60,000。
然后接一个故意不返回数据的服务器，调用它的工具。
你会看到报错从「等 27 小时」变成「一分钟超时」——
但真正先触发的是 30 分钟的空闲超时（如果你没把那个也改小）。
两层超时的关系就这样被验证出来了。

## 九、下一步

工具、钩子、技能、MCP 服务器都写完了。四个动手项目覆盖了拓展的四种形态：
进程内工具、事件钩子、提示词资产、外部进程。

下一章 Q19 是最后一章：把这一切放进 **headless 模式**，
做成一条 CI 里能跑的流水线——这才是「拓展」真正落地的地方。

---

> **本章读完你应该能回答**：
> ① MCP 工具的模型侧名字长什么样？
>    ——`mcp__server__tool`，三段式。
> ② `includeTools` 与 `excludeTools` 谁优先？
>    ——`excludeTools`，先排除再看白名单。
> ③ schema 三补丁分别解决什么？
>    ——键名非法、幽灵 required、嵌套结构不敢动。
> ④ 硬超时默认一亿毫秒是什么意思？
>    ——等于不设，真正的兜底是 30 分钟空闲超时。
> ⑤ 服务器连不上会怎样？
>    ——静默失败，只是它的工具不出现，对话继续。
