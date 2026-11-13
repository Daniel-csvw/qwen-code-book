---
title: "技能与插件 —— 能执行 shell 的提示词"
order: 11
part: "Part C · 上下文与资产"
eyebrow: "Q11"
meta: "1,494 字 · 119 行代码 · 7 块 · 约 14 分钟"
status: sample
snapshot: "1.0.0-preview @ 2026-11-12"
---

Skill 是什么？一句话：**一段可以带 shell 命令的提示词**。

它不是工具（不返回结构化结果），也不是记忆（不是常驻背景）。
它是一份模板，激活后展开成用户消息塞进对话。

本章拆它的展开过程，以及那个最危险的能力：
**Skill 体内的 shell 命令会在激活时立即执行。**

## 一、SkillManager 的两类技能

`SkillManager`（`packages/core/src/skills/skillManager.ts:401`，1,317 行）
管两类技能：

| 类型 | 来源 | 例子 |
| --- | --- | --- |
| 内置（bundled） | 代码内注册 | `loop` `batch` `debug` `verify` `simplify` |
| 外部（filesystem） | 文件系统扫描 | 用户目录、项目目录、插件 |

内置技能有 14 个源文件（`skills/bundled/`，不含测试）：

```text
batch.ts        debug.ts       index.ts       loop.ts
loop-md.ts      mcp-config.ts  memory-types.ts
quest.ts        remember.ts    run.ts         simplify.ts
verify.ts       workflow-authoring.ts  run-skill-generator.ts
```

它们不是 markdown 文件，而是 TypeScript 模块。
`registerBundledSkill`（`:379`）把模块注册进管理器。

两类技能的差别不只在来源，还在**能力**：

- 内置技能可以调 `skill.getBody` 动态生成正文（`:180`）；
- 外部技能走模板替换与 shell 注入。

## 二、激活路径：prepareSkillBody

`prepareSkillBody`（`packages/core/src/skills/inlineSkillActivation.ts:170-218`）
是激活的核心，49 行分两条路：

```ts
export async function prepareSkillBody(
  config: Config,
  skill: SkillDefinition,
  skillName: string,
  skillDir: string,
  args?: string,
  shellPermissionCheck?: ShellPermissionCheck,
  options?: InlineSkillActivationOptions,
): Promise<string> {
  // Dynamic body generator (bundled skills) — bypasses the
  // static template pipeline.
  if (skill.getBody) {
    const toolNames =
      options?.toolNames ??
      config
        .getToolRegistry()
        .getFunctionDeclarations(config.getModel())
        .flatMap((tool) => (tool.name ? [tool.name] : []));
    const context = {
      skillDir,
      sessionId: config.getSessionId?.() ?? '',
      toolNames: canSpawnSubagentAtDepth(options?.agentDepth ?? 0)
        ? toolNames
        : toolNames.filter((name) => name !== AGENT_TOOL_NAME),
    };
    return skill.getBody(args, context);
  }

  const rawSkillBody = substituteSkillBody(skill, {
    args,
    skillDir,
    sessionId: config.getSessionId?.() ?? '',
    pluginPath: skill.pluginPath,
    pluginId: skill.pluginId,
  });

  // SK54: If disableSkillShellExecution is set, replace shell commands with
  // a placeholder instead of executing them. Built-in skills are exempt.
  if (config.isSkillShellExecutionDisabled() && !skill.isBuiltin) {
    return replaceShellCommandsWithPlaceholder(rawSkillBody);
  }

  return executeShellInjection(
    config,
    rawSkillBody,
    skillName,
    skill.shell,
    shellPermissionCheck,
  );
}
```

第一条路（内置）里有个细节值得看：`toolNames` 过滤。
如果当前代理深度不允许再生成子代理，
就把 `Agent` 工具从可用工具列表里去掉（`:190-192`）。
这防止了「技能 → 子代理 → 技能 → 子代理」的无限嵌套。

第二条路（外部）三步：模板替换 → 安全检查 → shell 注入。


## 三、shell 注入：最危险的一段

`executeShellInjection`（`:239-`）把 Skill 正文里的 shell 命令执行掉，
把输出替换回正文。每个命令的逻辑（`:246-280`）：

```ts
return executeShellCommandsInPrompt(
  body,
  async (command: string) => {
    const executionShell = shellType ?? DEFAULT_SHELL_TYPE;
    // Check permission before execution
    if (shellPermissionCheck) {
      const allowed = await shellPermissionCheck(command, executionShell);
      if (!allowed) {
        throw new Error(
          `Shell command permission denied for skill
           "${skillName}": ${command}`,
        );
      }
    }

    const shellConfig = config.getShellExecutionConfig();
    const { result: resultPromise } = await ShellExecutionService.execute(
      command,
      getCwd(),
      () => {}, // no streaming output needed
      AbortSignal.timeout(30_000), // 30s timeout per command
      {
        ...shellConfig,
        shellType: executionShell,
        sessionId: config.getSessionId?.() ?? 'default',
        pager: 'cat',
        preventCwdChanges: true,
      },
    );
    const result = await resultPromise;
    if (result.error) {
      throw new Error(
        `Command failed (exit ${result.exitCode}):
         ${result.output || result.error.message}`,
      );
    }
    return result.output?.trim() ?? '';
  },
);
```

五个防护点，逐个看：

| 防护 | 值 | 作用 |
| --- | --- | --- |
| 权限检查 | `shellPermissionCheck` | 每个命令单独过权限 |
| 超时 | 30 秒 | 单个命令不许卡死 |
| `pager: 'cat'` | 禁用分页器 | 否则命令会挂在 `less` 里 |
| `preventCwdChanges: true` | 禁止改工作目录 | 防止污染后续命令 |
| 错误抛异常 | `throw` | 不静默忽略失败 |

`pager: 'cat'` 这条最容易漏。如果不设，某些命令会自动用分页器输出，
在非交互环境里会挂住直到超时。

`preventCwdChanges` 这条也有意思——Skill 里的命令不该改变会话的工作目录，
否则后面所有工具的相对路径都错位。


## 四、元数据标签：技能怎么被识别

`buildSkillMetadataTags`（`:147-161`）生成三行标签：

```ts
const parts = [
  `<${COMMAND_MESSAGE_TAG}>${skillName}</${COMMAND_MESSAGE_TAG}>`,
  `<${COMMAND_NAME_TAG}>${skillName}</${COMMAND_NAME_TAG}>`,
];
parts.push(`<${SKILL_FORMAT_TAG}>true</${SKILL_FORMAT_TAG}>`);
return parts.join('\n');
```

三行 XML 标签，作用是让下游能识别「这条消息来自技能」：

- `command-message` —— 展示用；
- `command-name` —— 路由用；
- `skill-format: true` —— 标记这是技能展开的正文。

斜杠命令走另一条路（`:152-154` 调 `buildSlashCommandMetadata`），
因为斜杠命令有参数需要保留。

## 五、基目录为什么不算权限

`buildSkillPromptContent`（`:225-234`）只做一件事——把基目录写进正文：

```ts
export function buildSkillPromptContent(
  skill: SkillDefinition,
  skillBody: string,
): string {
  if (skill.isBuiltin || isWorkflowSkill(skill)) {
    return skillBody;
  }

  return `Base directory for this skill: ${skill.skillRoot}\n\n${skillBody}`;
}
```

注释（`:220-224`）说明了一个关键点：

> A filesystem-backed skill's base directory is resource-location metadata,
> not a filesystem permission grant. Built-in skills are programmatic and
> have no resource root to expose.

也就是说：正文里写着「基目录是 `/some/path`」，
**不等于**模型可以随意读这个目录下的文件——
读文件还是要过 `Read` 工具的权限检查。

这个区分很重要。如果实现时把它当成权限授予，
一个恶意 Skill 只要声明基目录为 `/` 就能读遍全盘。

## 六、插件：技能的上游

插件是更大的容器，可以带技能、命令、钩子、MCP 配置。
规模：

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `pluginManager.ts` | 1,842 | 插件生命周期 |
| `marketplaceManager.ts` | 1,168 | 市场与远程源 |
| `pluginLoader.ts` | 961 | 加载 |
| `validatePlugin.ts` | 944 | 校验 |
| `schemas.ts` | 918 | schema 定义 |
| `loadPluginCommands.ts` | 656 | 命令装载 |

其中 `schemas.ts`（918 行）比 `pluginLoader.ts` 还大，
说明插件格式的校验规则本身就非常复杂。
这也解释了为什么有 `validatePlugin.ts` 的 944 行——
外部生态的输入不能信任。

`loadPluginCommands.ts`（656 行）说明插件不只带技能，
还能注册**斜杠命令**。这类命令跟技能共享 `SkillManager` 的注册表，
但走不同的激活路径。

## 七、工程暗坑

**1. `disableSkillShellExecution` 只对外部技能生效**
`:207` 的条件是 `config.isSkillShellExecutionDisabled() && !skill.isBuiltin`。
内置技能豁免——因为它们的正文是代码生成的，不受外部输入影响。
自定义技能时如果想让内置技能也不执行 shell，得自己加逻辑。

**2. 权限检查是逐命令的，不是逐技能**
`shellPermissionCheck(command, executionShell)` 每个命令调一次。
一个技能里有 5 条命令，就要过 5 次检查。
漏掉一次检查，就等于给这个技能开了后门。

**3. 30 秒超时是硬限制**
`AbortSignal.timeout(30_000)` 写在代码里，没有走配置。
技能里不能跑长时间的命令（比如 `npm install`）。
需要长任务就走 `Shell` 工具，那有独立的超时策略。

**4. 命令失败必须抛，不能返回空串**
`:275-279` 抛异常。如果改成返回空字符串，
模型会看到正文里「命令输出」的位置是空的，
然后基于缺失信息继续推理——错误会在下游放大。

**5. 基目录不是权限授予**
见第五节。把它当权限是安全漏洞。

**6. 子代理深度检查防止无限嵌套**
`:190-192` 在深度超限时过滤掉 `Agent` 工具。
如果自定义技能生成逻辑时不检查，会做出「技能套技能套技能」的递归。

## 八、本章源码索引

| 文件 | 行数 | 本章用到的位置 |
| --- | --- | --- |
| `packages/core/src/skills/skillManager.ts` | 1,317 | `:379` registerBundledSkill
| | | `:524-` discoverSkills，`:821-` addSkills |
| `packages/core/src/skills/inlineSkillActivation.ts` | 440 | `:147-161` 元数据标签
| | | `:170-218` prepareSkillBody，`:225-234` 正文拼装
| | | `:239-280` shell 注入 |
| `packages/core/src/skills/bundled/loop.ts` | 431 | 内置 loop 技能 |
| `packages/core/src/skills/bundled/run-skill-generator.ts` | 291 | 动态正文生成 |
| `packages/core/src/plugins/management/pluginManager.ts` | 1,842 | 插件生命周期 |
| `packages/core/src/plugins/pluginLoader.ts` | 961 | 插件加载 |
| `packages/core/src/plugins/validation/validatePlugin.ts` | 944 | 插件校验 |
| `packages/core/src/plugins/schemas.ts` | 918 | 插件 schema |
| `packages/core/src/plugins/loadPluginCommands.ts` | 656 | 命令装载 |

## 九、自己动手验证

```bash
node qw-examples/check/11-skills-plugins.mjs
```

预期输出：

```text
bundled skills: 14
activation paths: 2
shell guards: 5
metadata tags: 3
 1317 skills/skillManager.ts
  440 skills/inlineSkillActivation.ts
 1842 plugins/management/pluginManager.ts
  961 plugins/pluginLoader.ts
  944 plugins/validation/validatePlugin.ts
```

改一处试试：把 `prepareSkillBody` 里的
`if (config.isSkillShellExecutionDisabled() && !skill.isBuiltin)`
改成只判断 `config.isSkillShellExecutionDisabled()`。
然后启用这个开关，激活内置的 `loop` 技能。
结果是内置技能里的 shell 命令全部被替换成占位符，技能失效——
因为它本来就靠 shell 拿运行时信息。

## 十、下一步

技能讲完了。下一个问题是：**谁来决定调用哪个技能、什么时候停？**
`loop`、`batch`、`verify` 这些内置技能背后，是一套 Agent 与 Workflow 编排。
下一章 Q12 拆 `Agent` 工具与 Workflow 的执行模型。

---

> **本章读完你应该能回答**：
> ① Skill 是什么？跟工具、记忆的区别？
>    ——可带 shell 的提示词模板；不返回结构化结果，不是常驻背景。
> ② 技能体内的 shell 命令何时执行？
>    ——激活时立即执行，输出替换回正文。
> ③ 基目录写在正文里，是不是等于给了读权限？
>    ——不是。读文件仍要过 `Read` 工具的权限检查。
> ④ 为什么内置技能豁免 `disableSkillShellExecution`？
>    ——正文由代码生成，不受外部输入影响。
> ⑤ 为什么 30 秒超时写在代码里？
>    ——技能激活是同步路径，不允许长任务；长任务走 `Shell` 工具。
