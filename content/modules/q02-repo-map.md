---
title: "仓库地图 —— 4 个包、55 个目录、7 个入口"
order: 2
part: "Part A · 全景"
eyebrow: "Q02"
meta: "1,718 字 · 72 行代码 · 8 块 · 约 12 分钟"
status: final
snapshot: "1.0.0-preview @ 2026-11-12"
---

上一章说了四个包的分工。这一章把它们摊开，看清目录层级。

先给结论：`core` 有 **55 个顶层目录**，`cli` 有 **11 个入口框架类**。
这两个数字决定了全书的结构——55 个目录不可能一章一个，必须按职责合并；
11 个入口类说明「一个 Agent 可以被多少种方式驱动」。

## 一、core：55 个目录怎么分组

把 `packages/core/src/` 的 55 个目录按行数排一遍（口径：`.ts/.tsx`，排除测试）：

```text
utils          208 文件 / 47,182  ← 零散工具函数，散落各章
tools          166 文件 / 46,915  ← Q07 工具家族
services        84 文件 / 34,165  ← Q10 压缩 + Q05 传输
plugins         49 文件 / 16,111  ← Q11 插件系统
agents          38 文件 / 14,080  ← Q12 子 Agent
mcp             64 文件 / 13,260  ← Q07 MCP
provider        69 文件 / 12,601  ← Q05 模型层
permissions     54 文件 / 11,575  ← Q08 权限
hooks           23 文件 / 11,279  ← Q08 钩子
config          24 文件 / 10,334  ← Q02 自己在读
```

### 四个能力圈

55 个目录可以归到四个圈里，这个划分是全书按章节分组的依据：

| 圈 | 目录数 | 代表目录 | 谁在用 |
|---|---|---|---|
| **执行内核** | 8 | event-bus、core、tool-executor、client、tasks | Q03–Q08 |
| **上下文工程** | 9 | context、prompts、attachments、memory、compression-v2 | Q09–Q10 |
| **扩展生态** | 7 | skills、plugins、builtin-plugins、codemode、agents | Q11–Q12 |
| **周边设施** | 31 | utils、config、protocol、io、i18n、telemetry…… | 按需引用 |

**注意第四圈占了 31 个目录却只占约 8 万行**——它们是零件不是模块。
读书时不必逐个看，遇到时查一下职责即可。这也是全书不为它们立章的原因。

### 一个反直觉的事实

`utils/` 有 4.7 万行，是最大的目录，但它**不是**一个模块。
它是 208 个非测试文件（含测试共 340）组成的工具集合：字符串处理、路径归一、时间格式化、
错误判定、日志封装……随便挑几个看看：

```powershell
# 看 utils 里文件名的首字母分布，就知道它多杂
node check/00-utils-count.mjs
```

相反，`core/` 只有 7,699 行，却是整个系统的心脏——
`query()`、`QueryTerminal`、`doom-loop-guard` 都在这里，Q03 整章都在讲它。

**目录大小与重要性不成正比**，这是读大型仓库时最容易踩的认知偏差。

## 二、cli：七个入口，一个内核

`packages/cli/src/framework/` 下有 11 个非测试文件，其中 7 个是入口类：

```text
appFramework.ts              127 行  ← 抽象基类
 entryFramework.ts            22 行  ← 类型定义
 asyncInitializer.ts         100 行  ← 异步初始化辅助
 resourceInitialization.ts   208 行  ← 资源初始化
 tuiAppFramework.ts          338 行  ← 交互式终端
 headlessAppFramework.ts     370 行  ← 无头（脚本/CI）
 acpAppFramework.ts          346 行  ← ACP 协议服务端
 daemonAppFramework.ts       354 行  ← 常驻守护进程
 sdkAppFramework.ts          309 行  ← TypeScript SDK
 commandAppFramework.ts      290 行  ← 单命令执行
 remoteWorkerAppFramework.ts 305 行  ← 远程工作节点
```

前四个是基础设施，后七个是入口。**七个入口共享一个抽象基类**，
基类只规定了两件事（`appFramework.ts:36-68`）：

<!-- file: qwen-code-1.0.0-preview/packages/cli/src/framework/appFramework.ts:43-68 -->
```ts
  /** The entry's Settings；进程级权限管理器从它读规则与设置。 */
  abstract readonly settingsService: SettingsService;

  appPlugins?: AsyncInitializer<AppPluginRegistry>;
  permissionManager?: AsyncInitializer<PermissionManager>;

  private stopBackgroundPreparation?: () => Promise<void>;
  private restoreHookRunner?: () => void;

  /** Registers background work; products may override the download sources. */
  protected readonly prepareEnvironment: (
    signal: AbortSignal,
  ) => Promise<() => Promise<void>> = (signal) =>
    prepareWindowsEnvironment(signal);

  protected initializeRuntime(
    signal: AbortSignal,
    { argv, createHookRunner }: FrameworkInitInput,
    initialize: () => Promise<void>,
  ): Promise<void> {
    if (createHookRunner) {
      this.restoreHookRunner = HookSystem.setRunnerFactory(createHookRunner);
    }
    if (process.platform !== 'win32' || argv.bare) return initialize();
    return this.prepareWindowsShell(signal).then(initialize);
  }
```

三个设计要点：

1. **`settingsService` 是 abstract 的**——每个入口必须自己提供 Settings。
   但 `setSettingsServiceFactory` 是静态的，让入口在创建第一个服务前就把工厂装好
   （`appFramework.ts:36-41`）。这个顺序约束防止「服务先启动、配置后到」。
2. **`appPlugins` 与 `permissionManager` 是可选的 `AsyncInitializer`**——
   不是直接给实例，而是给「异步拿到实例」的能力。因为插件加载和权限初始化
   都可能要读磁盘、可能要等网络。
3. **Windows 有个特殊分支**（`:66`）：非 Windows 或 `--bare` 直接初始化；
   Windows 要先 `prepareWindowsShell`。注释没解释为什么，但从函数名
   `setShellIfWindows` 能猜出：Windows 下要确保 shell 环境就绪。

### 七个入口意味着什么

同一个 `core` 内核，可以被七种方式驱动：

| 入口 | 谁在用 | 特点 |
|---|---|---|
| tui | 人，交互式 | 渲染终端界面，可中断、可确认 |
| headless | 脚本、CI | 一次性跑完，输出 JSON/文本 |
| acp | 编辑器（VS Code / Zed） | Agent Client Protocol 标准协议 |
| daemon | 长期服务 | 常驻进程，多客户端共享 |
| sdk | 程序调用 | TypeScript SDK 的底层实现 |
| command | 单条命令 | `qwen -p "一句话"` 这类 |
| remoteWorker | 远程节点 | 分布式执行 |

**这就是「core 不依赖 UI」的回报**：内核一份，外壳七种，
每种外壳只关心自己的输入输出形态。Q13 会拆 ACP 与 headless 这两个最常用的。

## 三、resource 与 ink-shim：两个小角色

### resource：57 个文件，14,513 行

它是 `core` 的依赖，不是 `cli` 的。职责是 Settings 与资源加载：
配置文件读取、作用域合并、Schema 校验、资源路径解析。

为什么单独成包？因为它的依赖很干净（几乎不碰 Agent 逻辑），
可以被别的产品复用。`core/package.json` 里写着 `"@qwen-code/resource": "file:../resource"`——
本地包引用，不走 npm registry。

### ink-shim：13 行的最小包

一个包名占位符。根 `package.json` 的 dependencies 里写着 `"ink": "file:packages/ink-shim"`，
所以任何人 `import ... from 'ink'` 拿到的都是这个本地包。

它自己是个结构完整的最小 npm 包，三个文件：

```text
package.json    13 行   {"name":"ink","version":"7.0.0-gmn.0","private":true}
index.js         8 行   export * from '../cli/dist/src/ink/index.js';
index.d.ts       8 行   同上（类型声明）
```

真正的 Ink 兼容层在 `cli/src/ink/`——**117 个文件、22,557 行**。
注意 `index.js` 指口径：它 re-export 的是 `cli` 的**构建产物**
（`../cli/dist/src/ink/index.js`），不是 `src`。
所以不 build 就跑不起来——这一点 Q01 已经提过。

这个「13 行 shim + 2 万行实现」的组合，Q14 会解释：
它不是简单的包装，而是把 Ink 的渲染契约在自己手里重新实现了一遍。

## 四、依赖边界：一条不能越的线

四个包之间的依赖是**单向**的：

```text
  cli ──────> core ──────> resource
   │                       ^
   └───────────────────────┘
```

具体到 `package.json`：

| 包 | 依赖谁 |
|---|---|
| cli | @qwen-code/core、@qwen-code/resource |
| core | @qwen-code/resource |
| resource | 无内部依赖 |
| ink-shim | 无（就 3 个文件、29 行） |

**没有循环依赖，没有 `core` 反向依赖 `cli`。**
这条线保证了内核可测试、可复用。违反它最常见的方式是「在 core 里 import 一个 cli 的工具函数」——
看起来很省事，但会让 core 再也搬不走。

## 五、工程暗坑

**坑一：`packages/*` 不等于「所有子目录都是 `src` 结构」。**
根 `package.json:11-13` 的 workspaces 只有 `"packages/*"` 一行，
但 `ink-shim` 没有 `src/` 目录——它的 `index.js` 直接躺在包根，
re-export 的是 `cli` 的构建产物。所以 `source-index.mjs`（只扫描 `*/src`、
且只收 `.ts/.tsx`）统计它时是 0 文件。这不是漏统计，是它本来就没有 `src/`。

**坑二：55 个目录里有 4 个是「测试辅助」。**
`test-utils/`（3,182 行）、`constants/`、`fallback/`、`routing/` 这类目录
不是业务模块。数目录时容易把它们算进去，导致「有哪些模块」判断失真。

**坑三：同名目录不同职责。**
`core/config/`（24 文件 / 10,334 行）与 `cli/src/config/`（23 文件 / 5,936 行）
是两个完全不同的东西：前者是 Agent 运行配置，后者是 CLI 参数与 Settings。
读代码时看全路径，别看目录名。

## 六、本章源码索引

| 文件 | 行数 | 职责 |
|---|---|---|
| `cli/src/framework/appFramework.ts` | 126 | 七个入口的共同基类 |
| `cli/src/framework/tuiAppFramework.ts` | 337 | 交互式终端入口 |
| `cli/src/framework/headlessAppFramework.ts` | 369 | 无头入口（最大） |
| `cli/src/framework/acpAppFramework.ts` | 345 | ACP 服务端入口 |
| `core/src/event-bus/` | 19 文件 / 6,132 | 执行内核（Q03 主题） |
| `core/src/core/` | 43 文件 / 7,699 | query 门面与回合控制 |
| `resource/src/` | 57 文件 / 14,513 | Settings 与资源服务 |

## 七、自己动手验证

```powershell
cd sources/qwen-code-1.0.0-preview

# 1. core 有几个顶层目录？应为 55
node check/01-core-dirs.mjs

# 2. framework 有几个 AppFramework 子类？应为 7
node check/02-framework.mjs

# 3. package.json 里 resource 怎么引用的？应为 file:../resource
node check/03-resource-dep.mjs
```

### 改一处试试

`core/package.json` 里 `@qwen-code/resource` 是 `file:../resource`。
如果把它改成 `^1.0.0`（走 npm registry）会发生什么？

```text
改哪里  packages/core/package.json 的 dependencies
        "@qwen-code/resource": "file:../resource" → "^1.0.0"
预期    npm install 会去 registry 找 @qwen-code/resource，
        而它并未公开发布——安装失败。
连带    core 无法构建，cli 也跟着挂；整个仓库不可运行。
        （未实跑：会破坏本地环境，按 package.json 字面推断）
回滚    git checkout packages/core/package.json
```

## 八、下一步

地图看完了，接下来进内核。Q03 从 `query()` 那 35 行开始，
看它如何把活派给事件总线上的三个 handler——
这是全书最重要的一章，也是理解「85 行 vs 960 行」的关键。

---

> **本章读完你应该能回答**：
> ① core 的 55 个目录怎么分组？
>    ——四个圈：执行内核 8、上下文 9、扩展生态 7、周边设施 31。
> ② 为什么 utils 最大却不立章？
>    ——它是 208 个非测试文件的集合，不是模块。
> ③ 七个入口共享什么？
>    ——抽象基类只规定 settingsService + 初始化顺序，其余各自实现。
> ④ 四个包的依赖线是什么？
>    ——cli → core → resource，单向，无循环。
> ⑤ 为什么 core 不能 import cli？
>    ——一旦反向依赖，内核就搬不走，七种外壳的复用前提消失。

