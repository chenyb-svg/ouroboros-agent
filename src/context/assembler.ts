// =============================================================================
// Context Assembler — Builds agent-visible context in strict 4-step order
// =============================================================================

import type { AgentContract } from "../types/agents.js";
import type { UnifiedMessage } from "../types/context.js";
import type { ContextMergeStrategy } from "../types/context.js";
import type { TaskEntry } from "../types/orchestration.js";

export interface AssemblySources {
  /** Agent's own system prompt from contract */
  systemPrompt: string;
  /** CLAUDE.md translated rules (Phase 2: array of rules as strings) */
  claudeMdRules: string[];
  /** Shared project context (files, git status, etc.) */
  projectContext: string[];
  /** Conversation history to inject */
  conversationHistory: UnifiedMessage[];
  /** Active tasks relevant to this agent */
  activeTasks: TaskEntry[];
  /** Shared state key-values to inject */
  sharedState: Record<string, unknown>;
}


function createSystemMessage(obj: any): any { return { role: obj.role || "system", content: obj.content || "" }; }
function applyContextPolicy(msgs: any[], _policy: any, _agentId: string): any[] { return msgs; }

export class ContextAssembler {
  private cache = new Map<string, { messages: UnifiedMessage[]; version: number }>();
  private version = 0;

  /**
   * Assemble the full context for an agent.
   * Strict 4-step injection order:
   *   1. System prompt (contract + CLAUDE.md rules)
   *   2. Shared project context
   *   3. Conversation history (filtered by context policy)
   *   4. Active task state
   */
  assemble(
    contract: AgentContract,
    sources: AssemblySources,
    mergeStrategy: ContextMergeStrategy = "append",
  ): UnifiedMessage[] {
    const agentId = `${contract.identity.source}:${contract.identity.name}:${contract.identity.version}`;

    // Check cache
    const cacheKey = `${agentId}:${this.version}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached.messages;

    const messages: UnifiedMessage[] = [];

    // Step 1: System prompt
    const systemPrompt = this.buildSystemPrompt(
      sources.systemPrompt,
      sources.claudeMdRules,
      mergeStrategy,
    );
    messages.push(
      createSystemMessage({
        content: systemPrompt,
        agentId: "framework",
      }),
    );

    // Step 2: Shared project context
    if (sources.projectContext.length > 0) {
      messages.push(
        createSystemMessage({
          content: `[Project Context]\n${sources.projectContext.join("\n")}`,
          agentId: "framework",
        }),
      );
    }

    // Step 3: Conversation history (filtered by policy)
    const filteredHistory = applyContextPolicy(
      sources.conversationHistory,
      contract.contextPolicy,
      agentId,
    );
    messages.push(...filteredHistory);

    // Step 4: Active task state
    if (sources.activeTasks.length > 0) {
      const taskLines = sources.activeTasks.map(
        (t) => `- [${t.status}] ${t.taskId}: ${t.description}`,
      );
      messages.push(
        createSystemMessage({
          content: `[Active Tasks]\n${taskLines.join("\n")}`,
          agentId: "framework",
        }),
      );
    }

    // Cache result
    this.cache.set(cacheKey, { messages, version: this.version });

    return messages;
  }

  /**
   * Invalidate all cached assemblies (called when context changes).
   */
  invalidate(): void {
    this.version++;
    // Clear old cache entries
    this.cache.clear();
  }

  // ---- Private ----

  private buildSystemPrompt(
    contractPrompt: string,
    claudeMdRules: string[],
    strategy: ContextMergeStrategy,
  ): string {
    const parts: string[] = [];

    switch (strategy) {
      case "prepend":
        parts.push(...claudeMdRules);
        parts.push(contractPrompt);
        break;
      case "append":
        parts.push(contractPrompt);
        parts.push(...claudeMdRules);
        break;
      case "override":
        parts.push(...(claudeMdRules.length > 0 ? claudeMdRules : [contractPrompt]));
        break;
    }

    return parts.join("\n\n");
  }
}
