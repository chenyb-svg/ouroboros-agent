// =============================================================================
// Budget Enforcer — Checks budgets at critical points, terminates on exhaustion
// =============================================================================

import { randomUUID } from "node:crypto";
import type { EventBus } from "../bus/event-bus.js";
import { BudgetTracker } from "./tracker.js";

export class BudgetEnforcer {
  private tracker: BudgetTracker;
  private bus: EventBus;
  private sessionId: string;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private onTerminate: (() => void) | null = null;

  constructor(
    tracker: BudgetTracker,
    bus: EventBus,
    sessionId: string,
  ) {
    this.tracker = tracker;
    this.bus = bus;
    this.sessionId = sessionId;

    // Set up time budget timer
    const remaining = tracker.getRemainingTimeMs();
    if (remaining > 0 && remaining < Infinity) {
      this.timeoutTimer = setTimeout(() => {
        this.handleExhaustion("timeout", this.onTerminate);
      }, remaining);
      if (this.timeoutTimer.unref) this.timeoutTimer.unref();
    }
  }

  /**
   * Set the termination callback (called when budget exhausted).
   */
  onExhausted(callback: () => void): void {
    this.onTerminate = callback;
  }

  /**
   * Check budget before starting a new turn.
   * Returns true if the agent can continue.
   */
  checkBeforeTurn(instanceId: string, agentId: string): boolean {
    const status = this.tracker.getStatus();
    if (status.isExhausted) {
      this.handleExhaustion(
        status.exhaustedReason ?? "max_turns",
        this.onTerminate,
        instanceId,
        agentId,
      );
      return false;
    }
    return true;
  }

  /**
   * Check budget before making an LLM call.
   * Returns true if the call is allowed.
   */
  checkBeforeLlmCall(
    estimatedTokens: number,
    instanceId: string,
    agentId: string,
  ): boolean {
    const status = this.tracker.getStatus();
    const projectedTokens = status.tokensUsed + estimatedTokens;

    // Soft limit: allow but warn
    if (projectedTokens > status.spec.maxTokens * 0.9) {
      // Budget tight but not exhausted
    }

    if (status.tokensUsed >= status.spec.maxTokens) {
      this.handleExhaustion("max_tokens", this.onTerminate, instanceId, agentId);
      return false;
    }

    return true;
  }

  /**
   * Check budget before executing a tool.
   * Returns true if the tool call is allowed.
   */
  checkBeforeTool(
    toolFQN: string,
    instanceId: string,
    agentId: string,
  ): boolean {
    const status = this.tracker.getStatus();

    // Check file budget
    if (
      toolFQN.includes(":write") &&
      status.filesModified.length >= status.spec.maxFilesModified
    ) {
      this.handleExhaustion(
        "max_files_modified",
        this.onTerminate,
        instanceId,
        agentId,
      );
      return false;
    }

    // Check tool-specific budget
    const maxCalls = status.spec.maxToolCalls[toolFQN];
    if (maxCalls !== undefined) {
      const current = status.toolCallsByType[toolFQN] ?? 0;
      if (current >= maxCalls) {
        this.handleExhaustion(
          "max_tool_calls",
          this.onTerminate,
          instanceId,
          agentId,
        );
        return false;
      }
    }

    return true;
  }

  /**
   * Get the underlying tracker.
   */
  getTracker(): BudgetTracker {
    return this.tracker;
  }

  /**
   * Clean up timer.
   */
  dispose(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  // ---- Private ----

  private handleExhaustion(
    reason: string,
    onTerminate?: (() => void) | null,
    instanceId?: string,
    agentId?: string,
  ): void {
    const status = this.tracker.getStatus();

    this.bus.emit({
      eventId: randomUUID(),
      type: "BUDGET_EXCEEDED",
      timestamp: performance.now(),
      sessionId: this.sessionId,
      causalChainId: randomUUID(),
      sourceAgentId: agentId,
      payload: {
        agentInstanceId: instanceId ?? "unknown",
        agentId: agentId ?? "unknown",
        reason,
        budgetStatus: status as unknown as Record<string, unknown>,
      },
    });

    if (onTerminate) {
      onTerminate();
    }
  }
}
