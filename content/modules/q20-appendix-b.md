---
title: "附录 B · 源码坐标总表"
order: 21
part: "附录"
eyebrow: "附录 B"
meta: "129 个文件 · 209 条引用 · 约 6 分钟"
status: final
snapshot: "1.0.0-preview @ 2026-11-12"
---

全书 19 章共引用 **129 个源文件、209 处坐标**。
本表按引用次数排序，方便你想「改这个行为会影响哪几章」时反查。

| 引用次数 | 文件 | 出现在 |
| --- | --- | --- |
| 6 | `packages/core/src/event-bus/bus.ts` | Q01 Q03 |
| 5 | `packages/core/src/tools/tool-registry.ts` | Q07 Q15 |
| 5 | `packages/core/src/mcp/tools/mcp-tool.ts` | Q07 Q18 |
| 4 | `packages/core/src/core/agent-loop.ts` | Q03 |
| 4 | `packages/core/src/event-bus/llm-handler.ts` | Q05 |
| 4 | `packages/core/src/tools/tools.ts` | Q07 Q15 |
| 4 | `packages/core/src/skills/inlineSkillActivation.ts` | Q11 Q17 |
| 3 | `packages/cli/src/framework/appFramework.ts` | Q02 Q13 |
| 3 | `packages/core/src/event-bus/query-stream.ts` | Q03 |
| 3 | `packages/core/src/event-bus/llm/request-preparation.ts` | Q05 |
| 3 | `packages/core/src/protocol/transcript/message.ts` | Q06 |
| 3 | `packages/core/src/tools/tool-names.ts` | Q07 Q15 |
| 3 | `packages/core/src/mcp/mcp-schema-sanitizer.ts` | Q07 Q15 Q18 |
| 3 | `packages/core/src/hooks/types.ts` | Q08 Q16 |
| 3 | `packages/core/src/permissions/manager/tool-check.ts` | Q08 Q16 |
| 3 | `packages/core/src/hooks/hookPlanner.ts` | Q08 Q16 |
| 3 | `packages/core/src/hooks/hookAggregator.ts` | Q08 Q16 |
| 3 | `packages/core/src/context/memoryContextManager.ts` | Q09 |
| 3 | `packages/cli/src/headless/headlessSession.ts` | Q13 Q19 |
| 3 | `packages/cli/src/ink/renderer.ts` | Q14 |
| 3 | `packages/core/src/hooks/hookOutputSchema.ts` | Q16 |
| 2 | `packages/core/src/event-bus/state.ts` | Q04 |
| 2 | `packages/core/src/event-bus/conversation-handler.ts` | Q04 |
| 2 | `packages/core/src/core/query-event.ts` | Q04 |
| 2 | `packages/core/src/core/query-turn.ts` | Q04 |
| 2 | `packages/core/src/event-bus/conversation/tools-settled.ts` | Q04 Q07 |
| 2 | `packages/core/src/event-bus/llm/request-preparation-helpers.ts` | Q05 |
| 2 | `packages/core/src/event-bus/llm/inference-round.ts` | Q05 |
| 2 | `packages/core/src/event-bus/llm/result-assembly.ts` | Q05 |
| 2 | `packages/core/src/protocol/provider/request-converter.ts` | Q06 |
| 2 | `packages/core/src/mcp/client/mcpClient.ts` | Q07 Q18 |
| 2 | `packages/core/src/permissions/manager/permission-manager.ts` | Q08 |
| 2 | `packages/core/src/hooks/hookRunner.ts` | Q08 Q16 |
| 2 | `packages/core/src/context/system-context.ts` | Q09 |
| 2 | `packages/core/src/compression-v2/types.ts` | Q10 |
| 2 | `packages/core/src/compression-v2/pipeline.ts` | Q10 |
| 2 | `packages/core/src/skills/skillManager.ts` | Q11 |
| 2 | `packages/core/src/agents/types.ts` | Q12 |
| 2 | `packages/core/src/agents/subagent-tool.ts` | Q12 |
| 2 | `packages/resource/src/resource/kinds/skills/types.ts` | Q17 |
| 2 | `packages/core/src/utils/argumentSubstitution.ts` | Q17 |
| 2 | `packages/cli/src/services/SkillCommandLoader.ts` | Q17 |
| 2 | `packages/core/src/tools/activate-skill.ts` | Q17 |
| 2 | `packages/core/src/mcp/mcpServerConfig.ts` | Q18 |
| 2 | `packages/core/src/test-utils/test-mcp-server.ts` | Q18 |
| 2 | `packages/core/src/utils/headless.ts` | Q19 |
| 2 | `packages/cli/src/startup/options/headless.ts` | Q19 |
| 2 | `packages/cli/src/utils/headlessPermissionPrompt.ts` | Q19 |
| 1 | `packages/core/src/event-bus/events.ts` | Q03 |
| 1 | `packages/core/src/event-bus/runtime.ts` | Q03 |
| 1 | `packages/core/src/event-bus/conversation/model-settled.ts` | Q04 |
| 1 | `packages/core/src/event-bus/conversation/submit.ts` | Q04 |
| 1 | `packages/core/src/event-bus/conversation/context.ts` | Q04 |
| 1 | `packages/core/src/core/query-terminal.ts` | Q04 |
| 1 | `packages/core/src/core/turn-budget.ts` | Q04 |
| 1 | `packages/core/src/core/turn-hooks.ts` | Q04 |
| 1 | `packages/core/src/event-bus/llm/inference.ts` | Q05 |
| 1 | `packages/core/src/protocol/transcript/conversions.ts` | Q06 |
| 1 | `packages/core/src/protocol/transcript/message-utils.ts` | Q06 |
| 1 | `packages/core/src/protocol/provider/sse-client.ts` | Q06 |
| 1 | `packages/core/src/protocol/schemas/sdk-message.ts` | Q06 |
| 1 | `packages/core/src/protocol/wire/control.ts` | Q06 |
| 1 | `packages/core/src/tools/streaming-tool-executor.ts` | Q07 |
| 1 | `packages/core/src/tool-executor/state-manager.ts` | Q07 |
| 1 | `packages/core/src/tool-executor/types.ts` | Q07 |
| 1 | `packages/core/src/mcp/sessionMcpManager/sessionMcpManager.ts` | Q07 |
| 1 | `packages/core/src/mcp/connector/connectMcpServer.ts` | Q07 |
| 1 | `packages/core/src/hooks/hookEventHandler.ts` | Q08 |
| 1 | `packages/core/src/hooks/hookSystem.ts` | Q08 |
| 1 | `packages/core/src/hooks/hookRegistry.ts` | Q08 |
| 1 | `packages/core/src/permissions/manager/session-permission-manager.ts` | Q08 |
| 1 | `packages/core/src/permissions/permission-modes/auto/classifier.ts` | Q08 |
| 1 | `packages/core/src/permissions/permission-modes/auto/dangerous-rules.ts` | Q08 |
| 1 | `packages/core/src/permissions/settings/permissionsLoader.ts` | Q08 |
| 1 | `packages/core/src/attachments/generators/mcp-generators.ts` | Q09 |
| 1 | `packages/core/src/attachments/get-attachments.ts` | Q09 |
| 1 | `packages/core/src/attachments/types.ts` | Q09 |
| 1 | `packages/core/src/attachments/transcript-state.ts` | Q09 |
| 1 | `packages/core/src/attachments/generators/file-generators.ts` | Q09 |
| 1 | `packages/core/src/compression-v2/auto-compact.ts` | Q10 |
| 1 | `packages/core/src/compression-v2/fork-compact.ts` | Q10 |
| 1 | `packages/core/src/compression-v2/post-compact-finalize.ts` | Q10 |
| 1 | `packages/core/src/compression-v2/apply-post-compact.ts` | Q10 |
| 1 | `packages/core/src/compression-v2/ptl-retry.ts` | Q10 |
| 1 | `packages/core/src/compression-v2/tool-result-budget.ts` | Q10 |
| 1 | `packages/core/src/compression-v2/compact-utils.ts` | Q10 |
| 1 | `packages/core/src/skills/bundled/loop.ts` | Q11 |
| 1 | `packages/core/src/skills/bundled/run-skill-generator.ts` | Q11 |
| 1 | `packages/core/src/plugins/management/pluginManager.ts` | Q11 |
| 1 | `packages/core/src/plugins/pluginLoader.ts` | Q11 |
| 1 | `packages/core/src/plugins/validation/validatePlugin.ts` | Q11 |
| 1 | `packages/core/src/plugins/schemas.ts` | Q11 |
| 1 | `packages/core/src/plugins/loadPluginCommands.ts` | Q11 |
| 1 | `packages/core/src/agents/run-agent.ts` | Q12 |
| 1 | `packages/core/src/agents/run-subagent.ts` | Q12 |
| 1 | `packages/core/src/agents/fork-subagent.ts` | Q12 |
| 1 | `packages/core/src/agents/registry/agentRegistry.ts` | Q12 |
| 1 | `packages/core/src/agents/registry/agentLoader.ts` | Q12 |
| 1 | `packages/core/src/agents/builtin/explore-agent.ts` | Q12 |
| 1 | `packages/core/src/agents/subagent-sdk-events.ts` | Q12 |
| 1 | `packages/core/src/agents/teams/agent-team-runtime.ts` | Q12 |
| 1 | `packages/cli/src/framework/headlessAppFramework.ts` | Q13 |
| 1 | `packages/cli/src/framework/acpAppFramework.ts` | Q13 |
| 1 | `packages/cli/src/framework/tuiAppFramework.ts` | Q13 |
| 1 | `packages/cli/src/headless/permission.ts` | Q13 |
| 1 | `packages/cli/src/headless/controlStream.ts` | Q13 |
| 1 | `packages/cli/src/headless/streamJsonOutput.ts` | Q13 |
| 1 | `packages/cli/src/acp/acpSessionHost.ts` | Q13 |
| 1 | `packages/cli/src/acp/acpServer.ts` | Q13 |
| 1 | `packages/cli/src/acp/toolProjection.ts` | Q13 |
| 1 | `packages/cli/src/ink/render-node-to-output.ts` | Q14 |
| 1 | `packages/cli/src/ink/screen.ts` | Q14 |
| 1 | `packages/cli/src/ink/log-update.ts` | Q14 |
| 1 | `packages/cli/src/ink/output.ts` | Q14 |
| 1 | `packages/cli/src/ink/parse-keypress.ts` | Q14 |
| 1 | `packages/cli/src/ink/styles.ts` | Q14 |
| 1 | `packages/cli/src/ink/reconciler.ts` | Q14 |
| 1 | `packages/cli/src/ink/dom.ts` | Q14 |
| 1 | `packages/cli/src/ink/stringWidth.ts` | Q14 |
| 1 | `packages/cli/src/ink/optimizer.ts` | Q14 |
| 1 | `packages/cli/src/ui/utils/toolDisplayProjection.ts` | Q14 |
| 1 | `packages/core/src/tools/tool-execution-lifecycle.ts` | Q15 |
| 1 | `packages/resource/src/resource/kinds/skills/skillLoader.ts` | Q17 |
| 1 | `packages/resource/src/resource/kinds/skills/frontmatterParsers.ts` | Q17 |
| 1 | `packages/core/src/mcp/tools/mcp-names.ts` | Q18 |
| 1 | `packages/core/src/mcp/tools/mcp-timeouts.ts` | Q18 |
| 1 | `packages/cli/src/utils/nonInteractiveOutput.ts` | Q19 |
| 1 | `packages/cli/src/nonInteractiveCliCommands.ts` | Q19 |
| 1 | `packages/core/src/engine/headless-projection.ts` | Q19 |

## 怎么用这张表

**想读懂某个行为**：找引用次数最多的文件，那通常是核心。
`event-bus/bus.ts` 被引用 6 次，是全书最热的文件，Q03 的事。

**想改动某处**：在表里找到它，看「出现在」列里的章节号。
一个文件被 4 章引用，说明改它有 4 个地方需要同步复查。

**想验证坐标**：所有坐标都可用 `scripts/fact-check.mjs` 一次校验，
它会检查文件是否存在、行号是否越界。

## 关于行号的一个提醒

这些行号对应 `1.0.0-preview @ 2026-11-12` 这一份快照。
源码会变，行号会漂。所以本书所有论断都尽量给到**函数名 + 行号**两重坐标——
行号对不上时，按函数名搜。
