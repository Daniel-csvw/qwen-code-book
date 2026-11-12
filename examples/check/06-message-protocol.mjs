import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const CORE = path.join(REPO, "packages/core/src");
const read = (rel) => fs.readFileSync(path.join(CORE, rel), "utf8");
const lines = (rel) => read(rel).split(/\r?\n/).length - 1;
const uniq = (re, text) => [...new Set(text.match(re) ?? [])];

const msg = read("protocol/transcript/message.ts");
const conv = read("protocol/provider/request-converter.ts");
const idx = read("protocol/index.ts");

// 1. Message 联合体几个成员？应为 7
const uni = msg.match(/export type Message =[\s\S]*?;/)[0];
console.log("Message union:", uniq(/\w+Message\b/g, uni.split("=")[1]).length);

// 2. ContentBlock 几种？应为 4
const cb = msg.match(/export type ContentBlock =[\s\S]*?;/)[0];
console.log("ContentBlock:", uniq(/^\s+\| \w+/gm, cb).length);

// 3. MessageBase 里 is* 标志几个？应为 5
const mb = msg.match(/export interface MessageBase \{[\s\S]*?\n\}/)[0];
console.log("is* flags:", uniq(/^  is\w+/gm, mb).length);

// 4. normalizeMessagesForAPI 几道工序？数赋值
const nm = conv.match(/export function normalizeMessagesForAPI\([\s\S]*?\n\}/)[0];
console.log("pipeline steps:", (nm.match(/^  const \w+ = /gm) ?? []).length);

// 5. 三种 strip 集合？
console.log("strip sets:", (conv.match(/new Set<string>\(/g) ?? []).length);

// 6. 协议版本
console.log("protocol version:", (idx.match(/WIRE_PROTOCOL_VERSION = '([\d.]+)'/) || [])[1]);

// 7. 行数
for (const f of [
  "protocol/transcript/message.ts",
  "protocol/transcript/conversions.ts",
  "protocol/transcript/message-utils.ts",
  "protocol/provider/request-converter.ts",
  "protocol/provider/sse-client.ts",
  "protocol/schemas/sdk-message.ts",
  "protocol/wire/control.ts",
]) {
  console.log(String(lines(f)).padStart(5), f);
}
