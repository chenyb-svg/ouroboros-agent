// =============================================================================
// Responder — background auto-reply to cross-instance questions
// Every idle Ouroboros instance runs one Responder. When another instance sends
// an `ask` message to our inbox, the Responder answers it with a bounded mini
// ReAct loop (read-only tools only) and writes a `reply` back to the asker.
//
// Safety properties:
//  - Only runs while the main query is idle (isBusy() gate) — never competes
//    with a REPL/WeChat query for the LLM or tool executor.
//  - Read-only tool allowlist — the responder cannot write/edit/bash/ask, so it
//    can never spawn a recursive ask chain or an infinite message loop.
//  - Bounded (maxRounds tool calls), at-most-once per ask, and never throws.
// =============================================================================

import type { LlmChunk, LlmMessage, LlmTool } from "../llm/types.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ToolDefinition } from "../types/tools.js";
import type { Inbox } from "./inbox.js";
import type { InboxMessage } from "./inbox.js";
import type { Blackboard } from "./blackboard.js";
import { convertTools, desanitizeToolName } from "../llm/tool-converter.js";

export interface ResponderToolResult { success: boolean; output: string; error?: string }

/** The responder's OWN live agent-group membership, resolved at answer time. */
export interface ResponderGroupContext {
  groupName: string;
  role: "lead" | "member";
  purpose: string;
  leadName?: string;
  leadSessionId?: string;
}

export interface ResponderDeps {
  inbox: Inbox;
  blackboard?: Blackboard | null;
  /**
   * Live group context for THIS instance. Read at answer time (not constructed
   * once) so a roster change / set_lead immediately reflects in replies — the
   * responder must know it is a lead/member to answer "你是主代理吗？" correctly.
   */
  getGroupContext?: () => ResponderGroupContext | null;
  provider: LlmProvider;
  model: string;
  name: string;
  device: string;
  temperature?: number;
  maxTokens?: number;
  /** True while the main REPL/WeChat query is running — responder skips then. */
  isBusy: () => boolean;
  /** Tool execution gate (repl.ts wraps toolExecutor.execute). */
  executeTool: (fqn: string, args: Record<string, unknown>) => Promise<ResponderToolResult>;
  /** All registered tool definitions (from toolRegistry.listAll()) — filtered by allowlist. */
  toolDefs?: ToolDefinition[];
  pollIntervalMs?: number;
  maxRounds?: number;
  allowlist?: Set<string>;
}

/** Tools the responder may use — all read-only, nothing that can trigger asks/loops. */
export const DEFAULT_ALLOWLIST = new Set([
  "ouroboros:read",
  "ouroboros:ls",
  "ouroboros:cat",
  "ouroboros:find",
  "ouroboros:view",
  "ouroboros:search",
  "ouroboros:grep",
  "ouroboros:git",
  "ouroboros:memory",
  "ouroboros:websearch",
  "ouroboros:webfetch",
  // A lead answering an urgent member ask may ping the user with a desktop
  // notification — bounded side effect, cannot trigger asks/loops.
  "ouroboros:notify",
]);

const FALLBACK_REPLY = "（我暂时无法回答这个问题。）";

export class Responder {
  private timer: NodeJS.Timeout | null = null;
  private processing = false;
  private readonly maxRounds: number;
  private readonly pollIntervalMs: number;
  private readonly allowlist: Set<string>;

  constructor(private readonly deps: ResponderDeps) {
    this.maxRounds = deps.maxRounds ?? 4;
    this.pollIntervalMs = deps.pollIntervalMs ?? 2000;
    this.allowlist = deps.allowlist ?? DEFAULT_ALLOWLIST;
  }

  start(): void {
    if (this.timer) return;
    const t = setInterval(() => { void this.tick(); }, this.pollIntervalMs);
    // Don't keep a one-shot CLI process alive just for the responder.
    t.unref?.();
    this.timer = t;
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** One responder pass: claim the oldest ask, answer it, reply. Never throws. */
  async tick(): Promise<void> {
    if (this.processing) return;
    if (this.deps.isBusy()) return;
    let ask: InboxMessage | null = null;
    try { ask = this.deps.inbox.nextUnreadAsk(); } catch { return; }
    if (!ask) return;

    this.processing = true;
    try {
      // Claim at-most-once so a slow answer is never re-processed/re-surfaced.
      this.deps.inbox.markMessageRead(ask.id);
      const reply = (await this.answer(ask)).trim().slice(0, 4000) || FALLBACK_REPLY;
      if (ask.thread) this.deps.inbox.sendReply(ask.from.sessionId, ask.thread, reply);
    } catch { /* never throw into the app */ } finally {
      this.processing = false;
    }
  }

  private async answer(ask: InboxMessage): Promise<string> {
    const tools = this.buildTools();
    const sys = this.buildSystemPrompt(ask);
    const messages: LlmMessage[] = [
      { role: "user", content: `另一个 Agent（${ask.from.name}@${ask.from.device}）刚问了我一个问题，请直接、简洁地回答，需要的话先用只读工具查证。\n\n问题：${ask.text}` },
    ];

    let finalText = "";
    let lastText = "";
    for (let round = 0; round < this.maxRounds; round++) {
      const stream = this.deps.provider.call({
        messages,
        systemPrompt: sys,
        temperature: this.deps.temperature ?? 0.2,
        maxTokens: this.deps.maxTokens ?? 1500,
        tools,
        toolChoice: "auto",
      });
      let turnText = "";
      const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
      for await (const chunk of stream) {
        if (chunk.type === "text_delta") turnText += chunk.delta;
        else if (chunk.type === "tool_use_stop") {
          toolCalls.push({ id: chunk.id, name: chunk.name, args: (chunk as any).parsedArgs ?? {} });
        }
      }
      lastText = turnText.trim();
      if (toolCalls.length === 0) { finalText = lastText; break; }

      messages.push({
        role: "assistant",
        content: turnText,
        toolCalls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });
      for (const tc of toolCalls) {
        const fqn = desanitizeToolName(tc.name);
        let r: ResponderToolResult = { success: false, output: "", error: "tool unavailable" };
        try { r = await this.deps.executeTool(fqn, tc.args); } catch { /* tool error → report */ }
        messages.push({
          role: "tool",
          content: (r.success ? r.output : `Error: ${r.error ?? "unknown"}`).slice(0, 8000),
          toolCallId: tc.id,
        });
      }
    }
    return finalText || lastText || "";
  }

  private buildTools(): LlmTool[] {
    const defs = (this.deps.toolDefs ?? []).filter((t) => this.allowlist.has(t.fqn));
    return convertTools(defs);
  }

  private buildSystemPrompt(ask: InboxMessage): string {
    const me = this.deps.blackboard?.me?.() ?? null;
    const group = this.deps.getGroupContext?.() ?? null;
    const selfInfo = me
      ? `我最近正在做的事：${me.lastTask ? `"${me.lastTask.slice(0, 120)}"` : "（无）"}${me.lastResult ? `，结果：${me.lastResult.slice(0, 200)}` : ""}`
      : "（无自身状态可参考）";
    const lines = [
      "你是运行在 Ouroboros 多实例协作网络中的一个 Agent。",
      `你的身份：${this.deps.name}@${this.deps.device}。`,
      `对方身份：${ask.from.name}@${ask.from.device}。`,
    ];
    if (group) {
      lines.push(
        "",
        "## 我的代理组角色（以此为准）",
        group.role === "lead"
          ? `你是代理组 "${group.groupName}" 的主代理（LEAD）。组职责：${(group.purpose || "（无描述）").slice(0, 300)}。成员请你向用户汇报时，调用 ouroboros:notify 弹出桌面通知（message 给用户的简洁汇报），并在回复中确认已转达。`
          : `你是代理组 "${group.groupName}" 的成员（MEMBER）。主代理：${group.leadName ? `${group.leadName} (id: ${group.leadSessionId})` : "（无）"}。需要向用户汇报时，把内容发给主代理，由主代理转达。`,
        "回答对方关于你身份/角色/职责的询问时，以本组角色为准，不要被基础设置或记忆误导。",
      );
    }
    lines.push(
      selfInfo,
      "规则：",
      "- 只允许使用给定的只读工具（read/ls/search/grep/git 等）查证后回答；禁止使用 write/edit/bash/ask/send_message 等会改动状态或再发起询问的工具。",
      "- 这是单轮问答：不要反问、不要开启新对话、不要请求澄清。",
      "- 直接、简洁地给出答案本身，不要冗长解释。",
    );
    return lines.join("\n");
  }
}
