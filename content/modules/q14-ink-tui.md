---
title: "TUI 与 ink —— 为什么要把渲染库 fork 进来"
order: 14
part: "Part D · 使用侧"
eyebrow: "Q14"
meta: "1,378 字 · 58 行代码 · 7 块 · 约 12 分钟"
status: sample
snapshot: "1.0.0-preview @ 2026-11-12"
---

Q13 讲了七个入口。`tui` 是最复杂的一个——
它要把 Agent 的事件流实时渲染成终端界面，还要处理键盘、滚动、选择。

最意外的一件事：`packages/cli/src/ink/` **不是第三方依赖**，
而是一份 vendored 的分叉。

## 一、license 头说明了什么

每个 `ink/` 文件的头部都一样（`packages/cli/src/ink/renderer.ts:1-9`）：

```ts
/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */
```

三个信息：

1. **来源**：`@jrichman/ink` v6.6.7（不是官方 `ink`，是一个 fork）；
2. **动作**：移植到 TypeScript，并做了修改；
3. **合规**：保留 MIT 全文在 `ink/LICENSE`。

把渲染库 fork 进自己的仓库，这是个大决定。
代价是维护负担——上游更新要手动跟；
收益是完全控制渲染细节。

从 `ink/` 下有 55 个 `.ts` 文件（43 个非测试）、合计超过一万行这一点看，
这个 fork 已经被改得面目全非了。

## 二、ink 的文件分几层

按职责分四层：

| 层 | 文件 | 行数 |
| --- | --- | --- |
| 渲染 | `render-node-to-output.ts` | 1,517 |
| 屏幕 | `screen.ts` | 1,443 |
| 输出 | `log-update.ts` | 986 |
| 输出 | `output.ts` | 807 |
| 输入 | `parse-keypress.ts` | 1,181 |
| 样式 | `styles.ts` | 785 |
| 协调 | `reconciler.ts` | 513 |
| DOM | `dom.ts` | 444 |
| 文本 | `wrapAnsi.ts` / `stringWidth.ts` / `wrap-text.ts` | 385 / 236 / 153 |

四层的分工很清晰：

- **DOM 层**（`dom.ts` + `reconciler.ts`）—— 虚拟树与 diff；
- **布局层**（`render-node-to-output.ts`）—— 把树算成字符格子；
- **屏幕层**（`screen.ts`）—— 双缓冲与单元格 diff；
- **输出层**（`log-update.ts` + `output.ts`）—— 生成最小 ANSI 转义序列。

`stringWidth.ts` 单独存在是因为**终端里中文占两格**。
一个字符一格是 ASCII 的假设，CJK 会让整个布局错位。
这类细节就是 fork 的价值——通用库往往只做到「能用」。


## 三、双缓冲：为什么要有 frontFrame 与 backFrame

`createRenderer`（`packages/cli/src/ink/renderer.ts:41-`）的签名很能说明设计：

```ts
export default function createRenderer(
  node: DOMElement,
  stylePool: StylePool,
): Renderer {
  // Reuse Output across frames so charCache (tokenize + grapheme clustering)
  // persists — most lines don't change between renders.
  let output: Output | undefined;
  return (options) => {
    const { frontFrame, backFrame, isTTY, terminalWidth, terminalRows } =
      options;
    const prevScreen = frontFrame.screen;
    const backScreen = backFrame.screen;
```

两帧：`frontFrame` 是**已显示在屏幕上的**，`backFrame` 是**正在算的**。
渲染完做 diff，只把变化的单元格刷出去。

`output` 变量用闭包保存，注释说明原因：
复用 `charCache`（分词与字素簇），因为**大部分行在两次渲染之间没变**。
如果每帧新建 `Output`，缓存全丢，长会话会明显卡顿。

这段代码还有个防御（`:58-72`）：

```ts
// Return empty frame if yoga node doesn't exist or layout hasn't been
// computed yet. getComputedHeight() returns NaN before calculateLayout()
// is called. Also check for invalid dimensions (negative, Infinity) that
// would cause RangeError when creating arrays.
const computedHeight = node.yogaNode?.getComputedHeight();
const computedWidth = node.yogaNode?.getComputedWidth();
const hasInvalidHeight =
  computedHeight === undefined ||
  !Number.isFinite(computedHeight) ||
  computedHeight < 0;
```

三种非法情况：`undefined`、`NaN`/`Infinity`、负数。
`NaN` 来自「还没算布局」；`Infinity` 来自「未约束的尺寸」。
不拦就会 `new Array(NaN)` 抛 `RangeError`。

## 四、输出层：最小 ANSI 序列

`log-update.ts`（986 行）负责把 diff 变成终端指令。
它用了一组 CSI/OSC 序列（`:39-50`）：

```ts
import {
  CURSOR_HOME,
  eraseToEndOfLine,
  scrollDown as csiScrollDown,
  scrollUp as csiScrollUp,
  RESET_SCROLL_REGION,
  setScrollRegion,
} from './termio/csi.js';
import { LINK_END, link as oscLink } from './termio/osc.js';
```

两个重点：

- **滚动区域**（`setScrollRegion`）—— 只让某个矩形区域滚动，
  光标与固定行不受影响。聊天界面靠这个实现「消息滚动但输入框不动」。
- **超链接**（`oscLink`）—— 终端里的可点击链接，靠 OSC 序列实现。

`optimize(diff)`（`optimizer.ts:26`）在输出前做一轮优化：
合并相邻的同类操作，减少转义序列字节数。
终端渲染是 IO 密集的，字节数直接等于延迟。

## 五、输入层：1181 行的按键解析

`parse-keypress.ts`（1,181 行）处理键盘输入。为什么这么多行？
因为**终端按键不是标准化的**：

- 方向键：有的终端发 `ESC[A`，有的发 `ESC OA`；
- 组合键：`Ctrl+左方向` 在 macOS 和 Linux 上序列不同；
- 输入法：中文输入时按键会分多次到达，需要缓冲；
- 粘贴：大段粘贴会一次性涌入，要和逐字输入区分。

1181 行里绝大部分是兼容性分支。
这部分 fork 的价值最高——写一遍就再也不碰了。

## 六、ui 层的两个巨物

`ui/` 目录下有两个超大文件：

| 文件 | 行数 |
| --- | --- |
| `ui/hooks/useLocalTuiSessionOrchestrator.ts` | 4,660 |
| `ui/components/shared/text-buffer.ts` | 4,625 |

前者是会话编排——把内核事件流接进 React 状态；
后者是文本缓冲区，支持 vim 模式（`vim-buffer-actions.ts`，1,850 行）。

一个文本输入框有 4,625 行，说明它不只是「输入字符串」：
还有多行编辑、撤销、选区、光标移动、粘贴处理。

`useRuntimeProjection.ts`（1,010 行）这个文件名值得看：
**运行时投影**——把内核状态投影成 UI 可用的形状。
又一次出现了「投影」这个模式（Q06 / Q13 / 这里）。


## 七、工程暗坑

**1. `output` 必须是闭包变量**
`renderer.ts:47` 的 `let output: Output | undefined;` 在 `createRenderer` 外面、
`return (options) => {}` 里面。放到函数内部就等于每帧重建，
`charCache` 全部失效。

**2. 布局未算时必须返回空帧**
`getComputedHeight()` 在 `calculateLayout()` 之前返回 `NaN`。
不判就会 `RangeError`。这是 ink fork 里最常被踩的一处。

**3. `prevFrameContaminated` 不能忽略**
`RenderOptions` 里这个字段（`:32-36`）的注释说明了它的作用：

```ts
  // True when the previous frame's screen buffer was mutated post-render
  // (selection overlay), reset to blank (alt-screen enter/resize/SIGCONT),
  // or reset to 0×0 during a destructive clear.
  // Blitting from such a prevScreen would copy stale inverted cells,
  // blanks, or nothing. When false, blit is safe.
  // copy stale inverted cells, blanks, or nothing. When false, blit is safe.
  prevFrameContaminated: boolean;
```

四种污染来源：选区叠加、切屏、resize、SIGCONT、破坏性清屏。
污染时不能做 blit（直接拷贝上帧未变区域），否则会把旧的反色格或空白拷过来。

**4. 滚动区域必须复位**
`RESET_SCROLL_REGION` 与 `setScrollRegion` 成对出现。
设了区域不复位，后续所有输出都被限制在那个矩形里。

**5. `stringWidth` 不能只算 `.length`**
CJK 字符占两格，emoji 可能占两格或零格（组合字符）。
用 `.length` 算宽度会让所有含中文的行错位。

**6. `--bare` 模式不进 TUI**
Q13 讲过 `--bare` 是唯一跳 shell 准备与 TUI 的入口。
调试渲染问题时别用 `--bare`，那时根本没有渲染器。

## 八、本章源码索引

| 文件 | 行数 | 本章用到的位置 |
| --- | --- | --- |
| `packages/cli/src/ink/renderer.ts` | 188 | `:1-9` license 头
| | | `:25-37` RenderOptions，`:41-` createRenderer |
| `packages/cli/src/ink/render-node-to-output.ts` | 1,517 | 布局到字符格子 |
| `packages/cli/src/ink/screen.ts` | 1,443 | 屏幕与单元格 diff |
| `packages/cli/src/ink/log-update.ts` | 986 | ANSI 输出 |
| `packages/cli/src/ink/output.ts` | 807 | 输出缓冲 |
| `packages/cli/src/ink/parse-keypress.ts` | 1,181 | 按键解析 |
| `packages/cli/src/ink/styles.ts` | 785 | 样式系统 |
| `packages/cli/src/ink/reconciler.ts` | 513 | 虚拟树协调 |
| `packages/cli/src/ink/dom.ts` | 444 | 轻量 DOM |
| `packages/cli/src/ink/stringWidth.ts` | 236 | 显示宽度 |
| `packages/cli/src/ink/optimizer.ts` | 103 | diff 优化 |
| `packages/cli/src/ui/utils/toolDisplayProjection.ts` | 964 | 工具显示投影 |

## 九、自己动手验证

```bash
node qw-examples/check/14-ink.mjs
```

预期输出：
```text
ink files: 43
vendored fork: true
double buffer: true
csi imports: 6
 1517 render-node-to-output.ts
 1443 screen.ts
 1181 parse-keypress.ts
  986 log-update.ts
  385 wrapAnsi.ts
  236 stringWidth.ts
```

改一处试试：把 `createRenderer` 里的 `let output: Output | undefined;`
挪到 `return (options) => {` 内部。
然后跑一个长会话（100 轮以上），用 `--debug` 看每帧耗时：
会从个位数毫秒涨到几十毫秒，因为 `charCache` 每帧重建。

## 十、下一步

Part D 结束。内核与入口都讲完了。
Part E 进入实战——不再拆源码，而是讲**怎么用这个框架做拓展**：
写自定义工具、写钩子、写技能、接 MCP、搭 headless 流水线。

---

> **本章读完你应该能回答**：
> ① `ink/` 是第三方依赖吗？
>    ——不是，是 vendored 的 `@jrichman/ink` v6.6.7 分叉并移植。
> ② 为什么要双缓冲？
>    ——frontFrame 是屏幕上已有的，backFrame 是正在算的，diff 只刷变化。
> ③ `output` 为什么要放闭包？
>    ——复用 `charCache`，避免每帧重新分词与字素聚类。
> ④ `prevFrameContaminated` 是防什么的？
>    ——防止从被污染的上帧 blit，拷出旧反色格或空白。
> ⑤ 为什么 `stringWidth` 不能用 `.length`？
>    ——CJK 占两格、组合字符占零格，`.length` 算出来是错的。
