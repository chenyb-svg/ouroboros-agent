// =============================================================================
// Ouroboros WeChat Work (企业微信) Bot — headless entry (no REPL)
// =============================================================================
// For full experience (shared engine with REPL), run `npx tsx src/repl.ts` instead.
// This file is a thin headless entry for WeChat-only deployments.
// =============================================================================

import { readFileSync as rfs, existsSync as fexists } from "node:fs";
import { createWechatServer } from "./wechat/server.js";
import { loadConfig } from "./config/loader.js";
import { createProviders, resolveModel } from "./llm/factory.js";
import { ToolRegistry } from "./tools/registry.js";
import { ToolExecutor } from "./tools/executor.js";
import { EventBus } from "./bus/event-bus.js";
import { initSession } from "./session/lifecycle.js";
import { detectCapabilities } from "./terminal/detector.js";
import { MemoryStorage } from "./memory/storage.js";
import { MemoryExtractor } from "./memory/extractor.js";
import { SkillInstaller } from "./cli/skill-installer.js";
import { builtinTools } from "./tools/builtin-tools.js";

// ---- Load .env ----
if (fexists(".env")) { const c = rfs(".env", "utf-8"); for (const l of c.split("\n")) { const m = l.match(/^\s*(\w+)\s*=\s*(.+)/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); } }

const PORT = parseInt(process.env["WECHAT_PORT"] || "9878");

// ---- Init Engine ----
const config = loadConfig();
if (!process.env["DEEPSEEK_API_KEY"]) { console.error("DEEPSEEK_API_KEY not set"); process.exit(1); }
const provs = createProviders(config); const ds = provs.get("deepseek")!;
const provider = ds; const coordModel = resolveModel(config, "builtin:coordinator", "Coordinator");
const caps = detectCapabilities(); const sess = initSession(config, caps, process.cwd());
const sessionId = sess.meta.sessionId; const bus = new EventBus(sessionId);
const memoryStorage = new MemoryStorage(process.cwd()); const memoryExtractor = new MemoryExtractor(memoryStorage, sessionId);
const skillInstaller = new SkillInstaller();
const toolRegistry = new ToolRegistry(); toolRegistry.registerAll(builtinTools);
toolRegistry.registerAll(builtinTools.filter((t: any) => t.fqn.startsWith("ouroboros:")).map((t: any) => ({ ...t, fqn: t.fqn.replace("ouroboros:", "claude-code:"), source: "skill" })));
const toolExecutor = new ToolExecutor(toolRegistry, bus, sessionId);

const patchT = (fqn: string, fn: any) => { const t = toolRegistry.resolve(fqn); if (t) (t as any).execute = fn; };
patchT("ouroboros:load_skill", async (a: any) => { const n = a.skill_name as string; const c = skillInstaller?.loadFullContent(n); return c ? { success: true, output: c.slice(0, 12000) } : { success: false, output: "", error: `Not installed: ${n}` }; });
patchT("ouroboros:memory", async (a: any) => { const op = a.operation as string || "search"; const r: string[] = []; if (op === "search" || op === "recall") { const m = memoryStorage?.query((a.query as string) || "", 5) || []; r.push(...m.map((x: any) => `[${x.confidence.replace(/_/g, " ")}] ${x.fact}`)); } if (op === "list") { const c = memoryStorage?.counts(); r.push(`Working: ${c?.working || 0}, Long-term: ${c?.longterm || 0}`); } return { success: true, output: r.length > 0 ? r.join("\n") : "No memories." }; });
patchT("ouroboros:save_memory", async (a: any) => { const m = memoryStorage.write({ fact: a.fact as string, category: (a.category as any) || "general", scope: (a.scope as string) || "global", source: { agentId: "wechat", sessionId }, confidence: "auto_high" } as any); return { success: true, output: `Saved: ${m.fact}` }; });

// ---- Chat Loop (headless — simplified ReAct) ----
const conversationHistory: any[] = [];

async function queryLoop(input: string): Promise<string> {
  conversationHistory.push({ role: "user", content: input });
  memoryExtractor?.extract({ taskDescription: input, userInput: input, workerResult: "", agentId: "wechat", sessionId });
  const messages = conversationHistory.slice(-30);
  const tools = toolRegistry.listAll().filter((t: any) => t.source === "builtin").map((t: any) => {
    const props: Record<string, any> = {}; for (const pr of t.parameters) props[pr.name] = { type: pr.type, description: pr.description };
    return { name: t.fqn.replace(/:/g, "_"), description: t.description, parameters: { type: "object", properties: props, required: t.parameters.filter((p: any) => p.required).map((p: any) => p.name) } };
  });
  const sp = "你是Ouroboros AI助手，通过企业微信与用户交流。使用中文回复，简洁明了。";

  let full = "";
  for (let turn = 0; turn < 5; turn++) {
    let txt = ""; const tcs: any[] = [];
    try {
      const s = provider.call({ messages, systemPrompt: sp, temperature: coordModel.temperature, maxTokens: coordModel.maxTokens, tools, toolChoice: "auto" });
      for await (const c of s) { if (c.type === "text_delta") txt += (c as any).delta ?? ""; if (c.type === "tool_use_stop" && (c as any).parsedArgs) tcs.push({ id: (c as any).id, name: ((c as any).name ?? "").replace(/_/g, ":"), args: (c as any).parsedArgs }); }
      full += txt;
      const tcMsg = tcs.map((tc: any) => ({ id: tc.id, type: "function" as const, function: { name: tc.name.replace(/:/g, "_"), arguments: JSON.stringify(tc.args) } }));
      messages.push(tcMsg.length > 0 ? { role: "assistant", content: txt || "", toolCalls: tcMsg } : { role: "assistant", content: txt || " " });
      if (tcs.length === 0) { conversationHistory.push({ role: "assistant", content: txt || " " }); break; }
      for (const tc of tcs) { let fqn = tc.name; if (!toolRegistry.resolve(fqn)) fqn = tc.name.replace(/:/g, "_"); const r = await toolExecutor.execute(fqn, tc.args, { agentId: "wechat", instanceId: "", emit: () => { }, getBudget: () => ({ turnsUsed: 0, tokensUsed: 0 }) }); messages.push({ role: "tool", content: r.success ? r.output : `Error: ${r.error}`, toolCallId: tc.id }); }
    } catch (e: any) { full += `\n[Error]`; break; }
  }
  return full || "处理失败，请重试。";
}

// ---- Start ----
createWechatServer({
  enqueueQuery: async (input: string, _msgType: string) => {
    const text = await queryLoop(input);
    return { text, files: [] };
  },
}, PORT);

console.log(`🤖 Ouroboros WeChat Bot (headless) :${PORT}`);
console.log(`   Health:   http://localhost:${PORT}/health\n`);
