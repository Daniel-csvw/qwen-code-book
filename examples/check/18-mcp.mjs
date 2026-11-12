import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
﻿// Q18 验证脚本：MCP 的命名、传输与 schema 三补丁
// 用法：node qw-examples/check/18-mcp.mjs
import crypto from "node:crypto";

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const CORE = path.join(REPO, "packages/core/src");
const read = (p) => fs.readFileSync(path.join(CORE, p), "utf8");
const lines = (p) => read(p).split(/\r?\n/).length - 1;

// 1. 传输类型
const cfg = read("mcp/mcpServerConfig.ts");
const typeLine = /readonly type\?: ([^,]+),/.exec(cfg)[1];
const transports = typeLine.split("|").map((s) => s.replace(/[\x27\s]/g, "")).filter(Boolean);
console.log("transports:", transports.length, "->", transports.join(" / "));

const scopes = /export type McpServerScope = ([^;]+);/.exec(cfg)[1]
  .split("|").map((s) => s.replace(/[\x27\s]/g, "")).filter(Boolean);
console.log("server scopes:", scopes.length, "->", scopes.join(" / "));

// 2. 命名规则
const names = read("mcp/tools/mcp-names.ts");
console.log("tool name prefix:", /MCP_TOOL_PREFIX = \x27([^\x27]+)\x27/.exec(names)[1]);
console.log("separator:", /MCP_QUALIFIED_NAME_SEPARATOR = \x27([^\x27]+)\x27/.exec(names)[1]);
const hashLen = /digest\(\x27hex\x27\)\.slice\(0, (\d+)\)/.exec(names)[1];
console.log("non-ascii hash length:", hashLen);

// 实测 normalizeMcpSegment 的行为（复刻源码逻辑）
const norm = (seg) => {
  const slug = seg.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (!/[^\x00-\x7F]/.test(seg)) return slug;
  const hash = crypto.createHash("sha256").update(seg).digest("hex").slice(0, 12);
  return (slug || "u") + "_" + hash;
};
console.log("normalize(\x27my-server\x27):", norm("my-server"));
console.log("normalize(\x27发布工具\x27).length:", norm("发布工具").length);

// 3. schema 三补丁
const san = read("mcp/mcp-schema-sanitizer.ts");
console.log("property key pattern:", /MCP_PROPERTY_KEY_PATTERN = \/([^/]+)\//.exec(san)[1]);
console.log("max key length:", /MAX_KEY_LENGTH = (\d+)/.exec(san)[1]);
console.log("has pruneGhostRequired:", /function pruneGhostRequired/.test(san));
console.log("top-level only (comment):", /Nested `properties` inside array `items`/.test(san));

// 4. 超时
const t = read("mcp/tools/mcp-timeouts.ts");
const req = Number(/MCP_REQUEST_TIMEOUT_DEFAULT_MSEC = ([\d_]+)/.exec(t)[1].replace(/_/g, ""));
const hard = Number(/MCP_TOOL_HARD_TIMEOUT_DEFAULT_MSEC = ([\d_]+)/.exec(t)[1].replace(/_/g, ""));
const stdioIdle = Number(/MCP_STDIO_TOOL_IDLE_TIMEOUT_DEFAULT_MSEC = ([\d_]+)/.exec(t)[1].replace(/_/g, ""));
const remoteIdle = Number(/MCP_REMOTE_TOOL_IDLE_TIMEOUT_DEFAULT_MSEC = ([\d_]+)/.exec(t)[1].replace(/_/g, ""));
console.log("request timeout:", req, "ms");
console.log("hard timeout:", hard, "ms (~" + Math.round(hard / 3600000) + "h)");
console.log("idle timeout stdio/remote:", stdioIdle, "/", remoteIdle, "ms");

// 5. 参数往返
const tool = read("mcp/tools/mcp-tool.ts");
console.log("sanitize then restore:", tool.includes("sanitizeMcpInputSchema") && tool.includes("restoreOriginalArgKeys"));
console.log("isError accepts string:", /isError === \x27true\x27/.test(tool));

console.log("");
console.log("关键文件行数：");
for (const p of [
  "mcp/mcpServerConfig.ts",
  "mcp/tools/mcp-names.ts",
  "mcp/mcp-schema-sanitizer.ts",
  "mcp/tools/mcp-tool.ts",
  "mcp/tools/mcp-timeouts.ts",
  "mcp/client/mcpClient.ts",
  "mcp/connector/connectMcpServer.ts",
]) console.log(String(lines(p)).padStart(6), "core/src/" + p.replace(/\\/g, "/"));
