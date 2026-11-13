---
title: "开篇 —— Qoder 与 Qwen 合并后，这 56 万行在做什么"
order: 1
part: "Part A · 全景"
eyebrow: "Q01"
meta: "2,270 字 · 62 行代码 · 9 块 · 约 13 分钟"
status: final
snapshot: "1.0.0-preview @ 2026-11-12"
---

打开 `sources/qwen-code-1.0.0-preview/`，你会看到只有四个包。

不是一个庞大到需要分类的 monorepo，不是十几个各自为政的工作区，就四个：
`core`、`cli`、`resource`、`ink-shim`。

但行数不客气：**2,541 个源文件、584,003 行 TypeScript**。其中 `core` 占 33 万行，
`cli` 占 23 万行。这本书要做的，是把这 56 万行拆开，告诉你一次对话里
每一层为什么这么写。

## 一、这本书讲什么

一句话：**一个产品级 Coding Agent 的 Harness，是怎么从一个 85 行的入口长出来的。**

这里的「Harness」指外壳——不是模型本身，而是把模型变成能干活的 Agent 的那一整套：
工具调度、权限确认、上下文装配、会话持久化、失败恢复、插件机制。
模型换一代，外壳的复杂度不会降；外壳写得好不好，直接决定 Agent 能不能上生产。

全书的主线是一次 `query()` 的旅程：

```text
用户输入
   │
   ├─ Q03 事件总线 ──── 85 行入口如何把活派给三个 handler
   ├─ Q04 对话与回合─── 谁决定「再问一次模型」
   ├─ Q05 请求装配 ──── 一个 llm.request 怎么变成一次 HTTP 调用
   ├─ Q06 消息协议 ──── 七种消息怎么投影成一次请求
   ├─ Q07 工具与 MCP ── 45 个内置工具怎么接进同一张表
   ├─ Q08 权限与钩子 ── 什么时候必须停下来问人
   │
   ├─ Q09 上下文装配 ── 请求里到底塞了什么
   ├─ Q10 记忆与压缩 ── 上下文满了怎么办
   ├─ Q11 技能与插件 ── 怎么把新能力装进去
   ├─ Q12 子 Agent ──── 一个 Agent 怎么分裂成多个
   │
   ├─ Q13 ACP/headless ─ 让别的程序驱动它
   └─ Q14 TUI/ink ────── 终端界面怎么渲染
```

全书分五部分：

- **Part A（Q01–Q02）** 全景：这 56 万行是什么、目录怎么分。
- **Part B（Q03–Q08）** 内核：一次对话从入口到收工，六章拆完。
- **Part C（Q09–Q12）** 上下文与资产：模型看到什么、装不下怎么压、能力怎么挂。
- **Part D（Q13–Q14）** 前端：怎么从外面驱动它、终端怎么渲染。
- **Part E（Q15–Q19）** 实战：工具、钩子、技能、MCP、headless 流水线，五个动手项目。

附录 A 是按症状反查的索引，附录 B 是全书的源码坐标总表。

## 二、版本与许可：先把话说清楚

### 这是 Preview

根 `package.json:3` 写的是 `"version": "1.0.0"`，README 标题写的是
`Qwen Code 1.0 Preview`。两者不矛盾——它是 1.0 的预览版。

官方在 README 里明确了两件事（`README.md:7-11`）：

<!-- file: qwen-code-1.0.0-preview/README.md:7-11 -->
```markdown
## Preview status and community contributions

Qwen Code 1.0 is in Preview and evolving rapidly. We aim to maintain
compatibility with existing features and interfaces, but some interfaces,
configuration options, and behaviors may change before the release stabilizes.
```

**接口会变。** 所以本书所有论述都绑定在一个具体快照上：`1.0.0-preview @ 2026-11-12`。
每章正文不写「最新版如何如何」，只写「这个快照里是这样」。你手上的代码如果行号对不上，
先确认是不是同一个快照。

### Apache-2.0，但要看清血统

`LICENSE` 是标准 Apache-2.0。但更该读的是 `NOTICE`：

<!-- file: qwen-code-1.0.0-preview/NOTICE:9-13 -->
```text
Qwen Code is an independently developed project by the Qwen Team. It draws
inspiration from other command-line AI coding tools such as Google Gemini CLI
(Copyright 2025 Google LLC, licensed under the Apache License, Version 2.0).
Files newly added or modified by the Qwen Team carry a "Copyright 2026 Qwen
Team" line.
```

这段话把两件事钉死了：

1. **它是独立开发的项目**，不是 Gemini CLI 的 fork 分支。
2. **它借鉴了 Gemini CLI**，且文件头用版权行区分来源——
   `Copyright 2026 Google LLC` 是继承来的，`Copyright 2026 Qwen Team` 是新写的。

这个区分在读书时很有用。你会在源码里看到 `gemini` 开头的文件名、`GEMINI_` 开头的
环境变量、`GeminiChat` 之类的类型名。这些**多数是历史命名**，实现早已重写。
后面的章节遇到这类名字，会明确指出「名字是历史，实现已重写」，不让你浪费时间考古。

### 关于「合并」

changelog 第一条说得很直白（`changelog/qwen/changelog.md:9`）：

<!-- file: qwen-code-1.0.0-preview/changelog/qwen/changelog.md:7-9 -->
```markdown
## CLI 1.0.0-preview

- Introduce Qwen Code 1.0 Preview, bringing together the agent capabilities of
  Qoder and Qwen Code for code understanding, implementation, debugging,
  and testing.
```

Qoder 和 Qwen Code 的 Agent 能力合并进了同一套开源内核。
这在代码里的落点非常具体——`core/src/qoder/` 目录（4,831 行）和
`cli/src/auth/qoderProviders.ts`。登录过 Qoder 账号后，模型列表里会多出 Qoder 的模型
（`qoderProviders.ts:24-29` 的 `isQoderAccountConfigured()`）。

我们不做商业判断，只陈述代码事实：**这个仓库里有 Qoder 的客户端实现**，
有账号检测、模型目录、专用推理通道。至于服务端行为和商业发行版的差异，不在本书范围。

## 三、四个包怎么分工

`package.json:11-13` 的 workspaces 只有一行 `"packages/*"`，实际展开是四个：

```text
packages/core        1,381 文件 / 332,669 行   ← UI 无关的运行时
packages/cli         1,103 文件 / 236,821 行   ← 可执行 + TUI + 入口框架
packages/resource       57 文件 /  14,513 行   ← Settings 与资源服务
packages/ink-shim        3 文件 /      29 行   ← 占住 `ink` 包名的 shim
```

（数字来自 `node scripts/source-index.mjs` 实测，见附录的源码索引。）

四个包的依赖方向很清楚：

```text
  cli ──────────> core ──────────> resource
   │                                 ^
   └─────────────────────────────────┘

  ink-shim  ← 仅作为 npm 依赖名存在（根 package.json 的 dependencies）
```

- **`core` 是大脑**：所有 Agent 逻辑在这里，且**完全不依赖 UI**。
  它不知道终端长什么样，不知道有没有图形界面。这是它能同时被 CLI、桌面端、
  Web 端、IDE 插件复用的前提。
- **`cli` 是外壳集合**：`qwen` 命令、交互式 TUI、headless 模式、ACP 服务端、
  daemon——全都在这一个包里，通过 `framework/` 下的多个入口类分派。
- **`resource` 是配置底座**：Settings 服务、资源加载。`core` 依赖它，
  而不是自己管配置。
- **`ink-shim` 是个包名占位符**：3 个文件共 29 行，`index.js` 只做一句
  `export * from '../cli/dist/src/ink/index.js'`。它没有 `src/`，
  所以源码索引里计 0 文件；真正的 Ink 兼容层在 `cli/src/ink/`（22,557 行），Q14 会讲。

## 四、把仓库跑起来

### 前提

Node `>=20.18.1`（`package.json:7-9`）。比 Pi 的 `>=22.19` 宽松，
因为你不需要用 Node 直接剥 TypeScript——这个仓库走的是先构建再运行。

### 三步

```powershell
cd sources/qwen-code-1.0.0-preview

# 1. 装依赖（npm workspaces，不是 pnpm）
npm install --no-audit --no-fund

# 2. 构建
npm run build

# 3. 启动
npm run start
```

`npm run start` 实际执行的是 `node packages/cli/dist/bin.js`（`package.json:15`）——
先构建再运行，不 build 就跑不起来。这点和 Pi 相反：Pi 可以用 `--import` 直接跑 src，
Qwen 必须过一遍构建产物。

> **实操提示（本机实测）**：`core` 有 68 个依赖，其中 `sharp`、`keytar`、
> `@lydell/node-pty` 是原生模块，在内网 registry 下可能装不上。
> 本书的实验设计尽量避开「必须装完依赖」的路径——读码类的验证（大部分章节）
> 只用 Node 读文件即可，不需要 `node_modules`。

### 不需要装依赖也能做的验证

这是本书的一个设计原则：**能纯读文件验证的，就不要求你装环境**。

```powershell
# 看四个包的目录数（核心不是 0 就说明包在）
node -e "console.log(require('fs').readdirSync('packages').join(' '))"
```

后面每章的「自己动手验证」小节，都会优先给这种只用 Node 内置模块的命令。

## 五、这本书怎么读

### 三条路线

**路线一：只想理解架构（约 8 小时）**
Part A → Q03（事件总线）→ Q04（对话回合）→ Q07（工具与 MCP）→ Q09（上下文）→ Q13（ACP）。
跳过 Q05/Q06 的协议细节、Q14 的 TUI。

**路线二：想改它（约 15 小时）**
全读，但 Part B 可以略读 Q05/Q07 的清单部分。重点在 Part C 与 Part E——
那里讲的是「扩展点在哪、契约是什么」。

**路线三：想把它接进自己的系统（约 5 小时）**
Q03 → Q13（ACP/headless）→ Q19（自动化实战）→ Q15（Skill）→ Q17（MCP）。
这条路线不关心内核细节，只关心「怎么驱动它、怎么扩展它」。

### 每个论断都带坐标

正文里所有源码引用形如 `packages/core/src/event-bus/bus.ts:114`，
你可以直接跳到那一行。代码块上方的注释也标了文件与行号范围，方便对照。

行号是机器校验的：`node scripts/fact-check.mjs` 会扫全书引用，
检查文件是否存在、行号是否越界。**任何越界都会让构建失败。**

### 与 Pi 的对照

本书会不时和 Pi Agent 对照（本地已有 `sources/pi-main/`）。这不是为了比较优劣，
而是因为两套实现走了不同的路，对照能看清「同一个问题有多少种解法」。

对照只写在必要的地方：循环范式、工具调度、会话持久化、扩展机制。
每处对照都给双方的源码坐标，你可以自己去读。

三本书的分工，用一张表说清：

| 书 | 回答的问题 | 教学口径体量 |
|---|---|---|
| Pi Agent | Agent 本体怎么造（极简内核） | 23 万行 |
| **Qwen Code（本书）** | 产品级 Harness 怎么长 | **56 万行** |
| Better Harness | Agent 外围工程怎么评（证据评审） | 9 万行 |

Pi 用 `while` 循环加分支讲清一个 Agent 的全部语义；
Qwen 用 4 个包、55 个 core 子目录、一条事件总线应对真实产品的全部场景。
前者适合学原理，后者适合学工程。

## 六、体量分布：为什么章节权重要这么分

计数口径：`.ts/.tsx`，排除 test/spec/`__snapshots__`/fixtures/node_modules/dist；
行数 = 去掉末尾换行的内容行数（文件 85 行就是 85 行，不因末尾换行多算 1）。
这个口径贯穿全书：正文的「N 行」、frontmatter 的「N 行代码」、验证脚本的输出，
三者被 `npm run figures` 逐条比对，不一致就构建失败。

### core 的前十大目录

```text
utils            208 文件 / 47,182   ← 工具函数，散落各章
 tools            166 文件 / 46,915   ← Q07
 services          84 文件 / 34,165   ← Q10 + Q05
 plugins           49 文件 / 16,111   ← Q11
 agents            38 文件 / 14,080   ← Q12
 mcp               64 文件 / 13,260   ← Q07
 provider          69 文件 / 12,601   ← Q05
 permissions       54 文件 / 11,575   ← Q08
 hooks             23 文件 / 11,279   ← Q08
 config            24 文件 / 10,334   ← Q02
```

有一个结构值得注意：**最大的目录不是最重要的目录**。
`utils/` 占 4.7 万行，全是零散工具函数，不单独立章；
`core/` 只有 7,699 行，却是整个系统的心脏（Q03 的主题）。

### 章节权重是这么定的

| 章节 | 对应体量 | 选它的理由 |
|---|---|---|
| Q03 事件总线 | ~1,800 行 | 全书心脏，看懂了后面的都顺 |
| Q04 对话/回合 | ~1,500 行 | 决策逻辑集中地 |
| Q06 消息协议 | ~7,500 行 | 七种消息的投影规则全在这里 |
| Q07 工具与 MCP | ~6 万行 | 工具家族与 MCP 接入同一张表 |
| Q10 记忆/压缩 | ~24,000 行 | 上下文工程必修，compression-v2 是独立子系统 |
| Q11 技能/插件 | ~28,000 行 | 扩展生态的主战场 |

剩下十个 core 子目录（`codemode`、`sessions`、`workflows`、`event-bus`……）
各自分散到最近的章节，不单独立章，避免把书切成碎片。

## 七、本章小结

- Qwen Code 1.0 Preview 是 **4 个包、2,541 个文件、584,003 行**的开源 Coding Agent。
- `core` 是 UI 无关的运行时（33 万行），`cli` 是外壳集合（23 万行），
  `resource` 是配置底座，`ink-shim` 是只占包名的 29 行 shim。
- Apache-2.0；借鉴 Gemini CLI 但独立开发，文件头版权行区分来源。
- Qoder 的 Agent 能力合并在 `core/src/qoder/`，是客户端实现，服务端不在本书范围。
- **必须构建才能运行**（`npm run build` → `npm run start`），这点和 Pi 不同。
- 目录体量与重要性不成正比：`utils/` 最大但不立章，`core/` 最小却是心脏。

下一章 Q02 把四个包摊开，画出完整的仓库地图——
你会看到 `core` 下面有 **55 个顶层目录**，以及它们各自站在哪一层。
