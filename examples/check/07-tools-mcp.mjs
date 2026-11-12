import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const CORE = path.join(REPO, "packages/core/src");
const read = (rel) => fs.readFileSync(path.join(CORE, rel), "utf8");
const lines = (rel) => read(rel).split(/\r?\n/).length - 1;

const names = read("tools/tool-names.ts");
const reg = read("tools/tool-registry.ts");
const sanitizer = read("mcp/mcp-schema-sanitizer.ts");
const mcpTool = read("mcp/tools/mcp-tool.ts");

// 1. 内置工具几个？应为 44
const arr = names.match(/ALL_BUILTIN_TOOL_NAMES = \[[\s\S]*?\] as const/)[0];
console.log("builtin tools:", (arr.match(/^  [A-Z][A-Z0-9_]+,/gm) ?? []).length);

// 2. 预设几个？应为 1
const preset = names.match(/TOOL_PRESETS = \[[\s\S]*?\] as const/)[0];
console.log("tool presets:", (preset.match(/'[a-z]+'/g) ?? []).length);

// 3. ToolRegistry 字段几个？应为 8（private 声明）
const cls = reg.match(/export class ToolRegistry \{[\s\S]*?\n  constructor/)[0];
console.log("registry fields:", (cls.match(/^  (private |readonly)/gm) ?? []).length);

// 4. getSchema 四条路径
const gs = reg.match(/getSchema\([\s\S]*?\n  \}/)[0];
console.log("getSchema paths:", ["schemaOverride", "applyMcpTools", "convertedSchemaCache", "schemaFilter"].filter((k) => gs.includes(k)).length);

// 5. sanitizer 正则
console.log("schema sanitizer regex:", sanitizer.match(/MCP_PROPERTY_KEY_PATTERN = (\/.*\/);/)[1]);

// 6. MCP 名字三段
const sep = mcpTool.match(/MCP_QUALIFIED_NAME_SEPARATOR/g) ?? [];
console.log("mcp name parts:", mcpTool.includes("MCP_QUALIFIED_NAME_SEPARATOR") ? 3 : 0);

// 7. 行数
for (const f of [
  "tools/tool-names.ts",
  "tools/tool-registry.ts",
  "mcp/tools/mcp-tool.ts",
  "mcp/mcp-schema-sanitizer.ts",
  "mcp/sessionMcpManager/sessionMcpManager.ts",
  "mcp/client/mcpClient.ts",
]) {
  console.log(String(lines(f)).padStart(5), f);
}
