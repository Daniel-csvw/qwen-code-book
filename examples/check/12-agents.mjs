import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FROM_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPO = path.join(ROOT_FROM_SCRIPT, "sources/qwen-code-1.0.0-preview");
const CORE = path.join(REPO, "packages/core/src");
const read = (rel) => fs.readFileSync(path.join(CORE, rel), "utf8");
const lines = (rel) => read(rel).split(/\r?\n/).length - 1;
const t = read("agents/types.ts");
const tm = t.match(/export enum AgentTerminateMode \{[\s\S]*?\n\}/)[0];
console.log("terminate modes:", (tm.match(/^  \w+ = '/gm) ?? []).length);
const bd = path.join(CORE, "agents/builtin");
const agents = fs.readdirSync(bd).filter((f) => f.endsWith("-agent.ts"));
console.log("builtin agents:", agents.length);
console.log("turn defaults:", (t.match(/DEFAULT_\w*MAX_TURNS = \d+/g) ?? []).length);
const st = read("agents/subagent-tool.ts");
const methods = (st.match(/^  (private )?(async )?\w+[(:]/gm) ?? []).length;
console.log("agent tool methods:", methods);
for (const f of [
  "agents/types.ts",
  "agents/subagent-tool.ts",
  "agents/run-agent.ts",
  "agents/registry/agentRegistry.ts",
  "agents/run-subagent.ts",
  "agents/builtin/explore-agent.ts",
  "agents/subagent-sdk-events.ts",
  "agents/teams/agent-team-runtime.ts",
]) {
  console.log(String(lines(f)).padStart(5), f);
}
