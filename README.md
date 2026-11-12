<div align="center">

# Qwen Code 源码级教程

**对着 1.0.0-preview 真源码，逐行读透 56 万行的产品级 Harness**

<sub>本仓库由 <code>books/qwen-book/site/publish.mjs</code> 自动同步，请勿直接编辑</sub>

<sub>21 篇 · 35,340 字 · 1,959 行代码 · 约 8 小时读完</sub>

<br>

[![read online](https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E9%98%85%E8%AF%BB-daniel--csvw.github.io-eb6c36?style=for-the-badge&labelColor=1a1d28)](https://daniel-csvw.github.io/qwen-code-book/)

[![chapters](https://img.shields.io/badge/%E7%AB%A0%E8%8A%82-21-2d3142?style=flat-square)](https://daniel-csvw.github.io/qwen-code-book/)
[![words](https://img.shields.io/badge/%E5%AD%97%E6%95%B0-35%2C340-c792ea?style=flat-square)](https://daniel-csvw.github.io/qwen-code-book/)
[![source refs](https://img.shields.io/badge/%E6%BA%90%E7%A0%81%E5%9D%90%E6%A0%87-338%20%E5%A4%84-82aaff?style=flat-square)](https://daniel-csvw.github.io/qwen-code-book/)
[![qwen-code](https://img.shields.io/badge/qwen--code-v1.0.0--preview-4f5d75?style=flat-square)](https://github.com/QwenLM/qwen-code)

**[立即开始阅读 →](https://daniel-csvw.github.io/qwen-code-book/)**

</div>

---

## 这本书讲什么

一个 Agent 的循环可以写成 `while (true) { 模型; 工具; }`。
Qwen Code 1.0 Preview 选了反方向：它的 `agent-loop.ts` 只有 86 行，
真正干活的是一条事件总线与三个互不引用的 handler。

本书全部基于本地 1.0.0-preview 快照实读源码写成，**每个论断都带
`文件:行号` 坐标**，可以用本仓库附带的脚本一键校验。

- Part A 全景：Qoder × Qwen 合并意味着什么、4 个包怎么分工
- Part B 内核：一次 `query()` 的事件旅程（总线、回合、模型、工具、权限）
- Part C 上下文与资产：装配、记忆压缩、技能插件、子 Agent
- Part D 表面与集成：ACP/headless、TUI 与自研 Ink 层
- Part E 实战：五个可交付扩展，写 → 装 → 跑 → 验证

## 目录结构

| 路径 | 内容 |
|---|---|
| `index.html` | 站点首页（GitHub Pages 入口） |
| `modules/qNN-*.html` | 21 篇正文 |
| `content/modules/qNN-*.md` | 21 篇 Markdown 源文件（带 frontmatter） |
| `examples/check/*.mjs` | 20 个章节验证脚本 |
| `examples/check-expected.mjs` | 正文「预期输出」与脚本实测的对账脚本 |

## 自己验证

把上游源码快照放在与本书同级的位置，然后从仓库根运行：

```bash
# 校验第一章的可数事实：core/src 有几个顶层目录、几个 utils 文件
node examples/check/01-core-dirs.mjs
node examples/check/00-utils-count.mjs
```

全部 20 个脚本都可以这样单独跑，每个只输出可数事实，不需要安装任何依赖。

脚本按自身位置解析根目录，任意工作目录均可运行；
上游路径约定为 `<repo>/sources/qwen-code-1.0.0-preview/`。

## 版本与许可

- 教程内容：CC BY-NC-SA 4.0
- 引用的源码：Qwen Code（Apache-2.0），版权归 Qwen Team 与 Google LLC
- 快照：`1.0.0-preview @ 2026-11-12`。Preview 接口会变，行号可能漂移；
  对不上时按**函数名**搜，不要按行号。
