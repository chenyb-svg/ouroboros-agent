// =============================================================================
// Budget Tracker — Per-agent resource usage tracking
// =============================================================================

import type { BudgetSpec, BudgetStatus, BudgetExhaustedReason } from "../types/budget.js";

export class BudgetTracker {
  private spec: BudgetSpec;
  private turnsUsed = 0;
  private tokensUsed = 0;
  private startedAt: number;
  private toolCallsByType: Record<string, number> = {};
  private filesModified: string[] = [];

  constructor(spec: BudgetSpec) {
    this.spec = spec;
    this.startedAt = performance.now();
  }

  /** Record one loop turn. Returns true if budget still available. */
  recordTurn(): boolean {
    this.turnsUsed++;
    return this.turnsUsed <= this.spec.maxTurns;
  }

  /** Record token usage. Returns true if budget still available. */
  recordTokenUsage(tokens: number): boolean {
    this.tokensUsed += tokens;
    return this.tokensUsed <= this.spec.maxTokens;
  }

  /** Record a tool call by FQN. */
  recordToolCall(fqn: string): void {
    this.toolCallsByType[fqn] = (this.toolCallsByType[fqn] ?? 0) + 1;
  }

  /** Record a file modification. */
  recordFileModified(path: string): void {
    if (!this.filesModified.includes(path)) {
      this.filesModified.push(path);
    }
  }

  /** Get current budget status. */
  getStatus(): BudgetStatus {
    const now = performance.now();
    const elapsed = now - this.startedAt;

    let isExhausted = false;
    let exhaustedReason: BudgetExhaustedReason | undefined;

    if (this.turnsUsed > this.spec.maxTurns) {
      isExhausted = true;
      exhaustedReason = "max_turns";
    } else if (this.tokensUsed > this.spec.maxTokens) {
      isExhausted = true;
      exhaustedReason = "max_tokens";
    } else if (elapsed > this.spec.timeoutMs) {
      isExhausted = true;
      exhaustedReason = "timeout";
    } else if (this.filesModified.length > this.spec.maxFilesModified) {
      isExhausted = true;
      exhaustedReason = "max_files_modified";
    } else {
      // Check per-tool budgets
      for (const [fqn, count] of Object.entries(this.toolCallsByType)) {
        const max = this.spec.maxToolCalls[fqn];
        if (max !== undefined && count > max) {
          isExhausted = true;
          exhaustedReason = "max_tool_calls";
          break;
        }
      }
    }

    return {
      spec: this.spec,
      turnsUsed: this.turnsUsed,
      tokensUsed: this.tokensUsed,
      startedAt: this.startedAt,
      toolCallsByType: { ...this.toolCallsByType },
      filesModified: [...this.filesModified],
      isExhausted,
      exhaustedReason,
    };
  }

  /** Get remaining wall-clock time in ms. */
  getRemainingTimeMs(): number {
    const elapsed = performance.now() - this.startedAt;
    return Math.max(0, this.spec.timeoutMs - elapsed);
  }
}
