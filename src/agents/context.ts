// =============================================================================
// Agent Context — The sandbox boundary
// This is the ONLY object injected into agents. They never touch the bus directly.
// =============================================================================

import { randomUUID } from "node:crypto";
import type { EventBus } from "../bus/event-bus.js";
import type { AgentInstance, AgentLifecycleState } from "../types/agents.js";
import type { BudgetSpec, BudgetStatus } from "../types/budget.js";

/**
 * Shared state storage (in-memory for Phase 2).
 * Future: persistent file-backed storage in session shared/ directory.
 */
const sharedState = new Map<string, { value: unknown; ttl?: number; writtenAt: number }>();

export class AgentContext {
  readonly instanceId: string;
  readonly agentId: string;
  readonly agentType: string;
  private bus: EventBus;
  private sessionId: string;
  private budget: BudgetStatus;
  private requestStateChangeCb: (instanceId: string, to: AgentLifecycleState, reason: string) => boolean;

  constructor(
    instance: AgentInstance,
    bus: EventBus,
    sessionId: string,
    budget: BudgetStatus,
    requestStateChange: (instanceId: string, to: AgentLifecycleState, reason: string) => boolean,
  ) {
    this.instanceId = instance.instanceId;
    this.agentId = `${instance.contract.identity.source}:${instance.contract.identity.name}:${instance.contract.identity.version}`;
    this.agentType = instance.contract.type;
    this.bus = bus;
    this.sessionId = sessionId;
    this.budget = budget;
    this.requestStateChangeCb = requestStateChange;
  }

  // ---- Bus access (controlled) ---------------------------------------------

  /**
   * Emit an event through the agent's controlled channel.
   * The framework stamps sourceAgentId automatically.
   */
  emit(eventType: string, payload: Record<string, unknown>): void {
    const event = {
      eventId: randomUUID(),
      type: eventType,
      timestamp: performance.now(),
      sessionId: this.sessionId,
      causalChainId: randomUUID(),
      sourceAgentId: this.agentId,
      payload,
    } as import("../types/events.js").OuroborosEvent;
    this.bus.emit(event);
  }

  // ---- Shared State --------------------------------------------------------

  readSharedState<T = unknown>(key: string): T | undefined {
    const entry = sharedState.get(key);
    if (!entry) return undefined;

    // Check TTL
    if (entry.ttl && Date.now() - entry.writtenAt > entry.ttl) {
      sharedState.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  writeSharedState(key: string, value: unknown, ttlMs?: number): void {
    const oldValue = sharedState.get(key)?.value;

    sharedState.set(key, {
      value,
      ttl: ttlMs,
      writtenAt: Date.now(),
    });

    // Emit SHARED_STATE_CHANGED
    this.bus.emit({
      eventId: randomUUID(),
      type: "SHARED_STATE_CHANGED",
      timestamp: performance.now(),
      sessionId: this.sessionId,
      causalChainId: randomUUID(),
      sourceAgentId: this.agentId,
      payload: {
        key,
        oldValue,
        newValue: value,
        writtenBy: this.agentId,
      },
    });
  }

  // ---- Budget --------------------------------------------------------------

  getBudget(): BudgetStatus {
    return { ...this.budget };
  }

  getBudgetRemaining(): {
    turnsLeft: number;
    tokensLeft: number;
    timeLeftMs: number;
  } {
    return {
      turnsLeft: this.budget.spec.maxTurns - this.budget.turnsUsed,
      tokensLeft: this.budget.spec.maxTokens - this.budget.tokensUsed,
      timeLeftMs: this.budget.spec.timeoutMs - (performance.now() - this.budget.startedAt),
    };
  }

  // ---- Lifecycle -----------------------------------------------------------

  /**
   * Request a state change. The lifecycle manager decides whether to allow it.
   */
  requestStateChange(to: AgentLifecycleState, reason: string): boolean {
    return this.requestStateChangeCb(this.instanceId, to, reason);
  }
}
