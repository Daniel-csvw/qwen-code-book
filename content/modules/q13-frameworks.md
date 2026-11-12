---
title: "ACP 与 headless —— 内核怎么接进编辑器与脚本"
order: 13
part: "Part D · 使用侧"
eyebrow: "Q13"
meta: "1,412 字 · 69 行代码 · 8 块 · 约 13 分钟"
status: sample
snapshot: "1.0.0-preview @ 2026-11-12"
---

前面十二章都在讲内核。但内核不直接跑——它要被某个入口装配起来。
Q13 讲这件事：**七个入口，一套骨架**。

## 一、FrameworkMode 七个值

`packages/cli/src/framework/appFramework.ts:119-126`：

```ts
export type FrameworkMode =
  | 'tui'
  | 'headless'
  | 'sdk'
  | 'acp'
  | 'daemon'
  | 'remoteWorker'
  | 'command';
```

七个值对应七个 `AppFramework` 子类，都在 `framework/` 下：

| 模式 | 文件 | 行数 | 用途 |
| --- | --- | --- | --- |
| `tui` | `tuiAppFramework.ts` | 337 | 交互式终端 |
| `headless` | `headlessAppFramework.ts` | 369 | 脚本 / CI |
| `acp` | `acpAppFramework.ts` | 345 | 编辑器集成 |
| `sdk` | `sdkAppFramework.ts` | 308 | 编程调用 |
| `daemon` | `daemonAppFramework.ts` | 353 | 常驻服务 |
| `remoteWorker` | `remoteWorkerAppFramework.ts` | 304 | 远程执行 |
| `command` | `commandAppFramework.ts` | 289 | 短命令 |

七个文件的行数都在 280-370 之间，非常接近。
这不是巧合——它们共享同一套骨架。

## 二、骨架只有五个抽象

`AppFramework`（`:35-105`）是抽象基类，126 行里只有四个关键点：

```ts
export abstract class AppFramework {
  abstract readonly settingsService: SettingsService;
  abstract init(): Promise<void>;
  abstract dispose(): Promise<void>;
  async prepareSession(
    _fallbackSettings: SessionSettings,
  ): Promise<SessionHandle | undefined> {
    return undefined;
  }
}
```

三个必需（`settingsService` / `init` / `dispose`），一个可选（`prepareSession`）。

其余都是**模板方法**，基类实现好，子类不用管：

| 方法 | 行 | 做什么 |
| --- | --- | --- |
| `initializeRuntime` | `:58-68` | 装钩子工厂 + Windows shell 准备 |
| `prepareWindowsShell` | `:70-82` | 带 profiler 与 trace 的 shell 准备 |
| `disposeRuntimePreparation` | `:84-90` | 反向清理 |
| `createPluginManager` | `:95-97` | 默认插件管理器 |

`prepareSession` 的注释（`:101`）说明了它的边界：

```ts
/** Product handoff only. Ordinary local TUI keeps its
    existing creation path. */
```

「仅用于产品交接」。普通本地 TUI 不走这条路，只有特殊产品（比如把会话移交给 IDE）才用。
默认返回 `undefined` 就是「不接管」。


## 三、headless：没有窗口，权限问谁

headless 模式没有 UI，但权限（Q08）还是要过。
Q08 讲过一个降级规则：**想 ask 但没人能问，就 deny**。
headless 不能接受这个降级——否则大部分工具都会被拒。

解法是 `headless/permission.ts`（288 行）里的 `createNamedToolAskHandler`（`:42`）：

**用一个外部工具来充当「提问 UI」。**

具体做法是 `callNamedPermissionPromptTool`（`:84-`）：
调用配置里指定的一个工具（通常是个 MCP 工具，或者父进程提供的回调），
把「要不要允许这个操作」作为工具参数传出去，等它返回决定。

这就把「问用户」变成了「调工具」——而工具调用在 headless 里是通的。

## 四、控制流协议：通过 stdio 双向通信

`headless/controlStream.ts`（341 行）实现了一套基于 stdio 的协议。
两个方向：

**出方向：权限请求**（`encodeCanUseToolRequest`，`:203-243`）：

```ts
const wire: Record<string, unknown> = {
  subtype: 'can_use_tool',
  tool_name: request.toolName,
  input: request.input,
  tool_use_id: request.toolUseId,
  display_name: request.displayName,
};
if (request.details !== undefined) {
  wire['details'] = projectConfirmationDetailsForExternalUse(
    request.details as SerializableConfirmationDetails | undefined,
  );
}
if (request.permissionKind !== undefined) {
  wire['permission_kind'] = request.permissionKind;
}
```

注意 `projectConfirmationDetailsForExternalUse` 这个函数名。
**投影成对外可用的形状**——内部结构不能直接吐出去。
跟 Q06 的消息投影是同一个思路：内外之间要有一层转换。

**入方向：用户决定**（`decodeCanUseToolResponse`，`:245-278`）：

```ts
if (!isRecord(response)) {
  return { decision: MALFORMED_DECISION };
}
if (response['behavior'] === 'deny') {
  return {
    decision: {
      behavior: 'deny',
      message: asString(response['message']),
      interrupt: response['interrupt'] === true,
    },
  };
}
if (response['behavior'] !== 'allow') {
  return { decision: MALFORMED_DECISION };
}
```

两个 `return` 分支的顺序：

1. 不是对象 → `MALFORMED_DECISION`；
2. `behavior === 'deny'` → 拒绝；
3. `behavior !== 'allow'` → 也是 `MALFORMED_DECISION`。

第 3 条是关键：**不认识的 behavior 一律当成格式错误**，不是当成 allow。
这跟 Q08 讲的安全默认一致——外部输入不可信任。

允许的分支带三个可选字段（`:263-277`）：

```ts
const updatedInput = isRecord(response['updatedInput'])
  ? response['updatedInput']
  : undefined;
const updatedPermissions = Array.isArray(response['updatedPermissions'])
  ? (response['updatedPermissions'] as PermissionUpdate[])
  : undefined;
const permissionScope = toPermissionScope(response['permissionScope']);
```

- `updatedInput` —— 外部可以**改参数**再放行（跟 Q08 的主循环一致）；
- `updatedPermissions` —— 外部可以追加规则；
- `permissionScope` —— 三个值（`:280-286`）：`once` / `session` / `persist`。

三个作用域对应三种记忆长度：

| 作用域 | 有效期 |
| --- | --- |
| `once` | 本次调用 |
| `session` | 本次会话 |
| `persist` | 落盘，后续会话也生效 |

`persist` 是最需要谨慎的一个——它会把规则写进配置文件。
所以 `toPermissionScope` 用白名单校验，不在三个值里的返回 `undefined`（不写）。


## 五、ACP：编辑器集成的三个文件

ACP（Agent Client Protocol）是编辑器与代理之间的标准协议。
`packages/cli/src/acp/` 下三个主要文件：

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `acpSessionHost.ts` | 1,460 | 会话宿主 |
| `acpServer.ts` | 1,307 | 协议服务端 |
| `toolProjection.ts` | 555 | 工具投影 |

`toolProjection.ts` 这个文件名的含义值得说：
工具在内部是一套结构，在 ACP 协议里是另一套。**投影**就是这层转换。
跟 Q06 的消息投影、headless 的 `projectConfirmationDetailsForExternalUse`
是同一个模式：**每跨一次边界，就要过一次投影**。

`acpHistory.ts`（155 行）处理历史回放——编辑器重连时要把会话恢复出来。
`acpPromptContent.ts`（541 行）处理提示内容的组装。

## 六、七种入口的差异在哪

既然共享骨架，差异只在两个维度：

| 维度 | 各模式的选择 |
| --- | --- |
| 输出 | stdout / JSON 流 / ACP 帧 / ink 渲染 |
| 权限提问 | 终端弹窗 / 命名工具 / ACP 请求 / 自动判定 |

其余全一样：内核是同一个 `query()`，工具是同一张注册表，
记忆、压缩、钩子都是同一套。

这就是 Q01 讲的「产品级 Harness」的含义：
**内核与入口彻底解耦**，换入口不用改内核，改内核不用动七个入口。

## 七、工程暗坑

**1. `MALFORMED_DECISION` 不是 allow**
headless 的 `decodeCanUseToolResponse` 遇到不认识的 `behavior` 返回格式错误，
后续会降级成 deny。改成 allow 等于给外部进程一个「随便发什么都能过」的口子。

**2. `permissionScope` 要走白名单**
`toPermissionScope` 只认三个值。
如果写成 `return value as PermissionScope`，外部传 `'forever'` 就会被当成合法值，
后续 `persist` 分支可能误判。

**3. 确认详情必须投影**
`projectConfirmationDetailsForExternalUse` 不是可选的美化。
内部详情可能带不可序列化对象，直接 `JSON.stringify` 会丢字段或抛错。

**4. Windows 的 shell 准备不能跳**
`initializeRuntime`（`:66`）的 `process.platform !== 'win32'` 判断。
Windows 上要跑 `prepareWindowsEnvironment` 才能用 shell 工具。
`--bare` 模式是唯一跳过的入口。

**5. `prepareSession` 默认不接管**
返回 `undefined` 表示「沿用默认路径」。
如果所有子类都实现它，反而会让普通 TUI 的创建路径被绕开。

## 八、本章源码索引

| 文件 | 行数 | 本章用到的位置 |
| --- | --- | --- |
| `packages/cli/src/framework/appFramework.ts` | 126 | `:35-105` 抽象基类
| | | `:58-90` 模板方法，`:119-126` FrameworkMode |
| `packages/cli/src/framework/headlessAppFramework.ts` | 369 | headless 入口 |
| `packages/cli/src/framework/acpAppFramework.ts` | 345 | ACP 入口 |
| `packages/cli/src/framework/tuiAppFramework.ts` | 337 | TUI 入口 |
| `packages/cli/src/headless/permission.ts` | 288 | `:42` 命名工具提问，`:84-` 调用 |
| `packages/cli/src/headless/controlStream.ts` | 341 | `:203-243` 编码，`:245-278` 解码
| | | `:280-286` 作用域白名单 |
| `packages/cli/src/headless/headlessSession.ts` | 954 | headless 会话 |
| `packages/cli/src/headless/streamJsonOutput.ts` | 258 | JSON 流输出 |
| `packages/cli/src/acp/acpSessionHost.ts` | 1,460 | ACP 会话宿主 |
| `packages/cli/src/acp/acpServer.ts` | 1,307 | ACP 服务端 |
| `packages/cli/src/acp/toolProjection.ts` | 555 | 工具投影 |

## 九、自己动手验证

```bash
node qw-examples/check/13-frameworks.mjs
```

预期输出：
```text
framework modes: 7
framework subclasses: 7
abstract members: 3
permission scopes: 3
decision branches: 2
  126 framework/appFramework.ts
  369 framework/headlessAppFramework.ts
  345 framework/acpAppFramework.ts
  337 framework/tuiAppFramework.ts
  288 headless/permission.ts
  341 headless/controlStream.ts
```

改一处试试：把 `decodeCanUseToolResponse` 里
`if (response['behavior'] !== 'allow')` 的分支改成返回 allow。
然后从标准输入发一条 `{"behavior":"maybe"}`。
工具会被放行——外部进程只要写个不存在的值就能绕过权限。

## 十、下一步

七个入口里，`tui` 是最复杂的一个——它要把 Agent 的事件流渲染成终端界面。
下一章 Q14 拆 `packages/cli/src/ink/` 与 `ui/`：
为什么选 `ink`、组件怎么分层、流式输出怎么不闪屏。

---

> **本章读完你应该能回答**：
> ① 有几个入口？共享什么？
>    ——七个；共享 `AppFramework` 骨架与同一个内核。
> ② headless 没有 UI，权限问谁？
>    ——用一个命名工具充当提问通道。
> ③ 外部传了不认识的 behavior 怎么办？
>    ——`MALFORMED_DECISION`，最终降级成 deny。
> ④ `permissionScope` 三个值分别管多久？
>    ——`once` 单次、`session` 单会话、`persist` 落盘。
> ⑤ 为什么每跨一次边界都要投影？
>    ——内部结构可能不可序列化，且外部不应依赖内部形状。
