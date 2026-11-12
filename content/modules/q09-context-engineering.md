---
title: "上下文工程 —— 三层记忆与并发飞行"
order: 9
part: "Part C · 上下文与资产"
eyebrow: "Q09"
meta: "1,567 字 · 122 行代码 · 12 块 · 约 15 分钟"
status: sample
snapshot: "1.0.0-preview @ 2026-11-12"
---

Part B 讲完内核，Part C 转向「模型看到什么」。
Q09 讲上下文怎么攒，Q10 讲装不下时怎么压。

先说结论：Qwen Code 的上下文来源分**三层**，每层的加载时机不同。
理解这三层，比记住一堆文件名有用。

## 一、三层记忆

`MemoryContextManager`（`packages/core/src/context/memoryContextManager.ts:120`，1,337 行）
把记忆分成四类路径，但加载策略只有三档：

| 层 | 来源 | 时机 | 信任要求 |
| --- | --- | --- | --- |
| 全局 | 用户目录 | 会话启动 | 无 |
| 项目 | 工作区目录 | 会话启动 | 需可信文件夹 |
| JIT | 按访问路径向上找 | 用到才加载 | 需可信根 |

`discoverMemoryPaths`（`:469-505`）实现前两层的发现：

```ts
const [global, envResult] = await Promise.all([
  isAllowed('user')
    ? getGlobalMemoryPaths(this.config.getAllContextFileNames())
    : Promise.resolve([]),
  isAllowed('project') && this.config.isTrustedFolder()
    ? getEnvironmentMemoryPaths(
        this.config
          .getWorkspaceContext()
          .getDirectories()
          .map((directory) => this.resolveMemoryPath(directory)),
        this.config.getAllContextFileNames(),
        this.config.getMemoryBoundaryMarkers(),
        this.resolveMemoryPath(this.config.getTargetDir()),
      )
    : Promise.resolve({ project: [] as string[], local: [] as string[] }),
]);
```

注意 `isTrustedFolder()` 这个条件。**不可信的文件夹，项目记忆根本不读。**
原因很直接：`.qwen/QWEN.md` 这类文件会进系统提示，
如果随便打开一个克隆下来的仓库就加载它的指令文件，
等于把别人的 prompt 注入到自己会话里。

全局层反过来——它在本机用户目录，不受文件夹信任状态影响。

第三个条件 `getAllowedAgentSources()` 是子代理场景的过滤器：
子代理可以限制只读 `user` 或只读 `project`。

## 二、外部导入的两道闸

记忆文件支持 `@import` 语法（引入其它文件）。
这是个明显的攻击面：项目里的 `QWEN.md` 可以 `@import /etc/passwd`。

`loadMemoryContents`（`:507-622`）把路径分成两批（`:508-514`）：

```ts
// Split paths into two groups:
// 1. Global/plugin: always allow external imports
// 2. Project/local: gate external imports behind approval
const alwaysExternalPaths = Array.from(
  new Set([...paths.global, ...paths.plugin]),
);
const gatedPaths = Array.from(new Set([...paths.project, ...paths.local]));
```

读取时传不同的标志（`:544-563`）：

```ts
const [alwaysExternalContents, gatedContents] = await Promise.all([
  alwaysExternalDeduped.length > 0
    ? readMemoryMdFiles(
        alwaysExternalDeduped,
        importFormat,
        boundaryMarkers,
        true, // always allow external imports for global/extension/userProject
        contextFileNames,
      )
    : Promise.resolve([]),
  gatedDeduped.length > 0
    ? readMemoryMdFiles(
        gatedDeduped,
        importFormat,
        boundaryMarkers,
        externalApproved, // gate by approval status
        contextFileNames,
      )
    : Promise.resolve([]),
]);
```

第 4 个参数就是闸门：全局/插件路径传 `true`，项目/本地路径传 `externalApproved`。

被拦下的导入不是静默丢弃，而是记进 `pendingExternalImports`（`:568-576`），
后续走审批流程通知用户。这个设计比「拒绝加载整个文件」合理——
记忆文件本身还是能用的，只是外部导入被挡住。

还有一道细节：去重按**文件身份**而不是字符串（`:527-529`）：

```ts
// deduplicate by file identity to handle case-insensitive filesystems
const { paths: allPaths, identityMap: pathIdentityMap } =
  await deduplicatePathsByFileIdentity(allPathsStringDeduped);
```

Windows 和 macOS 的文件系统大小写不敏感，
`QWEN.md` 和 `qwen.md` 是同一个文件。用字符串去重会重复加载两遍。

## 三、JIT 加载：用到才读

`discoverContext`（`:777-788`）是第三层：

```ts
discoverContext(
  accessedPath: string,
  trustedRoots: string[],
  signal?: AbortSignal,
): Promise<string> {
  return this.enqueueStateMutation(() =>
    raceWithAbortSignal(
      this.discoverContextUnchecked(accessedPath, trustedRoots, signal),
      signal,
    ),
  );
}
```

两件事：

1. **`enqueueStateMutation`** —— 串行化。JIT 加载会改状态，并发会打架；
2. **`raceWithAbortSignal`** —— 可取消。加载记忆可能很慢（要向上遍历目录）。

注释（`:773-776`）说明语义：

```ts
 * Discovers and loads context for a specific accessed path (Tier 3 - JIT).
 * Traverses upwards from the accessed path to the project root.
```

从被访问的路径**向上遍历到项目根**。
读到 `src/foo/bar.ts` 就找 `src/foo/`、`src/`、根目录里的记忆文件。
这跟 `.gitignore` 的层级语义一致，符合直觉。

## 四、系统上下文：用 Promise 做缓存

`getSystemContext`（`packages/core/src/context/system-context.ts:295-374`）
管的是 git 状态这类环境信息。它的缓存实现值得单独讲——80 行里有三个防坑点。

**要点一：缓存的是 Promise，不是结果。**

```ts
const cacheKey = buildCacheKey(sessionId, cwd);
const cachedEntry = cachedPromises.get(cacheKey);
if (cachedEntry) {
  if (!cachedEntry.reuseLogged) {
    cachedEntry.reuseLogged = true;
    runLogger.log(
      `[system-context] cache lookup cache_hit=true ` +
        `session_id=${sessionId} cwd=${cwd}`,
    );
  }
  return cachedEntry.promise;
}
```

这样**并发调用会自动合并**：第一个调用还没完成，第二个调用拿到同一个 Promise，
不会重复跑 git。如果缓存的是结果，第二个调用要么等待（得自己加锁），
要么重复执行。

**要点二：超时不算错误，按空结果处理并驱逐缓存。**

```ts
let evictAfterSettle = false;
const promise = collectGitContext(cwd, abortController.signal)
  .catch((error: unknown) => {
    if (
      error instanceof GitSystemContextTimeoutError ||
      error instanceof GitMetadataProbeTimeoutError
    ) {
      evictAfterSettle = true;
      runLogger.debug(
        `[system-context] collection deadline exceeded ` +
          `session_id=${sessionId} cwd=${cwd}`,
      );
      return {};
    }
    throw error;
  })
```

git 状态拿不到不该阻塞对话，返回空对象继续。
但**必须把缓存条目删掉**（`:349-357`），否则这个空结果会一直命中。

**要点三：取消不能污染缓存。**

```ts
// A cancelled flight must not poison the cache. A later caller can retry
// with a fresh controller instead of inheriting a rejected promise.
void promise.catch(() => {
  if (cachedPromises.get(cacheKey)?.abortController === abortController) {
    cachedPromises.delete(cacheKey);
  }
});
```

这里有个容易写错的地方：判断条件是
`cachedPromises.get(cacheKey)?.abortController === abortController`。
必须比对 `abortController` 引用，不能只判断 key 存在。

因为失败期间可能有新调用已经建了新条目，
这时候删除就会把**新条目**误删——旧请求的失败清掉了新请求的缓存。

## 五、记忆分类与信任边界

`categorizeMemoryContents`（`packages/core/src/context/memoryContextManager.ts:624-640`）：

```ts
private categorizeMemoryContents(
  paths: MemoryPathSet,
  contentsMap: Map<string, MemoryFileContent>,
) {
  const hierarchicalMemory = categorizeAndConcatenate(paths, contentsMap);

  this.globalMemory = hierarchicalMemory.global || '';
  this.pluginMemory = hierarchicalMemory.plugin || '';
  this.localMemory = hierarchicalMemory.local || '';

  // MCP instructions are now injected via delta attachments
  // (mcp_instructions_delta) instead of being baked into project memory.
  // See packages/core/src/attachments/generators/mcp-generators.ts
  this.projectMemory = this.config.isTrustedFolder()
    ? hierarchicalMemory.project || ''
    : '';
}
```

四段记忆分开存，**项目记忆再判一次信任**。
前面 `discoverMemoryPaths` 已经判过一次，这里又判一次。
这不是冗余——从发现到使用之间，文件夹信任状态可能被用户改变。

注释里那句也值得注意：MCP 指令**不再**塞进项目记忆，
改为通过增量附件（`mcp_instructions_delta`）注入。
因为 MCP 服务器可能中途连上，塞进记忆就没法更新了。

## 六、四条注入路径的对比

综合起来，模型看到的上下文有四个来源：

| 来源 | 注入方式 | 时机 | 可变 |
| --- | --- | --- | --- |
| 系统提示 | 请求参数 | 每轮 | 否 |
| 记忆 | `startupMemoryPrefix` | 会话启动 | 压缩时刷新 |
| 系统上下文 | 环境消息 | 每轮（缓存） | 是（git 变了） |
| 附件 | `attachment` 消息 | 按需 | 是 |

Q05 讲的 `prefixMessages`（`startupMemoryPrefix`）只出现在请求里，
**不进历史**。这是刻意的：记忆是「常驻背景」，不该被压缩算法当成历史内容处理。

## 七、工程暗坑

**1. `isTrustedFolder()` 是记忆加载的总开关**
`discoverMemoryPaths` 和 `categorizeMemoryContents` 各判一次。
自定义加载逻辑时如果漏判，会把不可信仓库的指令读进系统提示。

**2. Promise 缓存驱逐必须比对 `abortController`**
`system-context.ts:353` 和 `:368` 两处都是这个条件。
只比 key 会误删新建的条目。

**3. JIT 加载必须串行**
`enqueueStateMutation` 包住整个 `discoverContextUnchecked`。
并发调用会让 `loadedFileIdentities` 状态错乱，导致重复加载或漏加载。

**4. 外部导入被拦不等于文件失效**
`pendingExternalImports` 只记录被拦的 `@import`，
文件正文照常进记忆。实现审批 UI 时不要误以为整个文件被拒。

**5. 文件身份去重不可省**
`deduplicatePathsByFileIdentity` 处理大小写不敏感文件系统。
在 Linux 上跑测试永远发现不了这个 bug，在 Windows/macOS 上会重复注入记忆。

## 八、本章源码索引

| 文件 | 行数 | 本章用到的位置 |
| --- | --- | --- |
| `packages/core/src/context/memoryContextManager.ts` | 1,338 | `:469-505` discoverMemoryPaths |
| | | `:507-622` loadMemoryContents，`:624-640` 分类 |
| | | `:695-771` InstructionsLoaded 钩子，`:777-788` JIT |
| `packages/core/src/context/system-context.ts` | 420 | `:295-374` getSystemContext |
| | | `:377-380` 预取接管 |
| `packages/core/src/attachments/get-attachments.ts` | 1,005 | 附件收集入口 |
| `packages/core/src/attachments/types.ts` | 707 | 附件类型定义 |
| `packages/core/src/attachments/transcript-state.ts` | 614 | 附件与转录状态同步 |
| `packages/core/src/attachments/generators/file-generators.ts` | 821 | 文件类附件生成 |

## 九、自己动手验证

```bash
node qw-examples/check/09-context.mjs
```

预期输出：

```text
memory groups: 4 global,plugin,project,local
memory layers: 3
system context guards: 3
concurrent flight cache: true
trust checks: 5
  1337 context/memoryContextManager.ts
  420 context/system-context.ts
 1005 attachments/get-attachments.ts
  821 attachments/generators/file-generators.ts
```

改一处试试：把 `getSystemContext` 里的 `cachedPromises.set(cacheKey, cacheEntry)`
改成「等 Promise resolve 后再存结果」。
然后并发发两条消息，观察日志里 `collectGitContext` 的执行次数：
会从 1 次变成 2 次——每个调用方各跑一遍 git。

## 十、下一步

上下文攒起来了，但总会装不下。
下一章 Q10 拆 `packages/core/src/compression-v2/`：
压缩什么时候触发、压缩后保留什么、压缩本身失败了怎么办。

---

> **本章读完你应该能回答**：
> ① 上下文分几层？各自何时加载？
>    ——三层：全局/项目（会话启动）、JIT（用到才加载）。
> ② 为什么项目记忆要判两次可信？
>    ——发现到使用之间，信任状态可能被改变。
> ③ 系统上下文缓存为什么存 Promise 而不是结果？
>    ——并发调用自动合并，不需要额外加锁。
> ④ 驱逐缓存为什么必须比对 `abortController`？
>    ——否则旧请求的失败会误删新请求的条目。
> ⑤ 记忆为什么用 `startupMemoryPrefix` 而不进历史？
>    ——常驻背景不该被压缩算法当作历史内容处理。
