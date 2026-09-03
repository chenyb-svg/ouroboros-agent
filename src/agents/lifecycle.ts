// =============================================================================
// Agent Lifecycle Manager — Drives agent state machine
// States: discovered → loaded → idle → active → paused → terminating → terminated → archived
// Agents REQUEST state changes; the manager DECIDES and enforces.
// =============================================================================

import { randomUUID } from "node:crypto";
import type { EventBus } from "../bus/event-bus.js";
import type {
  AgentLifecycleState,
  AgentInstance,
} from "../types/agents.js";
import type { BudgetStatus } from "../types/budget.js";

// Valid transitions
const VALID_TRANSITIONS: Record<AgentLifecycleState, AgentLifecycleState[]> = {
  discovered: ["loaded"],
  loaded: ["idle", "loaded"],       // reload stays in loaded
  idle: ["active", "terminating"],
  active: ["paused", "terminating"],
  paused: ["active", "terminating"],
  terminating: ["terminated"],
  terminated: ["archived"],
  archived: [],                      // terminal state
};

export class AgentLifecycleManager {
  private instances = new Map<string, AgentInstance>();
  private bus: EventBus;
  private sessionId: string;

  constructor(bus: EventBus, sessionId: string) {
    this.bus = bus;
    this.sessionId = sessionId;
  }

  /**
   * Register a newly discovered agent instance.
   */
  register(instance: AgentInstance): void {
    this.instances.set(instance.instanceId, instance);
    this.emitLifecycleEvent(instance, "discovered");
  }

  /**
   * Transition an agent instance to a new state.
   * Validates the transition, updates instance, emits events.
   */
  transition(
    instanceId: string,
    to: AgentLifecycleState,
    reason: string,
  ): boolean {
    const instance = this.instances.get(instanceId);
    if (!instance) return false;

    const from = instance.state;
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
      return false;
    }

    instance.state = to;

    // Emit lifecycle events
    if (to === "active") {
      this.emitAgentSpawned(instance);
    } else if (to === "terminated" || to === "archived") {
      this.emitAgentTerminated(instance, reason);
    }

    // Emit state change
    this.bus.emit({
      eventId: randomUUID(),
      type: "STATE_CHANGE",
      timestamp: performance.now(),
      sessionId: this.sessionId,
      causalChainId: randomUUID(),
      sourceAgentId: instance.contract.identity
        ? `${instance.contract.identity.source}:${instance.contract.identity.name}:${instance.contract.identity.version}`
        : "unknown",
      payload: {
        previous: from,
        current: to,
        reason,
        agentId: instance.instanceId,
      },
    });

    return true;
  }

  /**
   * Get an instance by ID.
   */
  get(instanceId: string): AgentInstance | undefined {
    return this.instances.get(instanceId);
  }

  /**
   * List instances by state or type.
   */
  list(filter?: {
    state?: AgentLifecycleState;
    type?: string;
    parentInstanceId?: string;
  }): AgentInstance[] {
    let results = [...this.instances.values()];
    if (filter?.state) results = results.filter((i) => i.state === filter.state);
    if (filter?.type) results = results.filter((i) => i.contract.type === filter.type);
    if (filter?.parentInstanceId !== undefined) {
      results = results.filter((i) => i.parentInstanceId === filter.parentInstanceId);
    }
    return results;
  }

  /**
   * Count of active agents (for status bar).
   */
  activeCount(): number {
    return this.list({ state: "active" }).length;
  }

  /**
   * Remove terminated instances beyond retention period.
   * Called by GC sweep.
   */
  sweep(now: number, retentionMs: number): string[] {
    const removed: string[] = [];
    for (const [id, instance] of this.instances) {
      if (instance.state === "terminated") {
        const age = now - (instance.spawnedAt || 0);
        if (age > retentionMs) {
          this.transition(id, "archived", "gc_sweep");
          removed.push(id);
        }
      }
    }
    return removed;
  }

  /**
   * Update budget status for an instance.
   */
  updateBudget(instanceId: string, budget: BudgetStatus): void {
    const instance = this.instances.get(instanceId);
    if (instance) {
      instance.budgetStatus = budget;
    }
  }

  // ---- Private ----

  private emitLifecycleEvent(instance: AgentInstance, _state: AgentLifecycleState): void {
    // Internal event tracking — the main events are AGENT_SPAWNED/AGENT_TERMINATED
  }

  private emitAgentSpawned(instance: AgentInstance): void {
    this.bus.emit({
      eventId: randomUUID(),
      type: "AGENT_SPAWNED",
      timestamp: performance.now(),
      sessionId: this.sessionId,
      causalChainId: randomUUID(),
      sourceAgentId: instance.parentInstanceId,
      payload: {
        instanceId: instance.instanceId,
        agentId: `${instance.contract.identity.source}:${instance.contract.identity.name}:${instance.contract.identity.version}`,
        agentType: instance.contract.type,
        parentInstanceId: instance.parentInstanceId,
        taskId: instance.taskId,
      },
    });
  }

  private emitAgentTerminated(instance: AgentInstance, reason: string): void {
    this.bus.emit({
      eventId: randomUUID(),
      type: "AGENT_TERMINATED",
      timestamp: performance.now(),
      sessionId: this.sessionId,
      causalChainId: randomUUID(),
      sourceAgentId: `${instance.contract.identity.source}:${instance.contract.identity.name}:${instance.contract.identity.version}`,
      payload: {
        instanceId: instance.instanceId,
        agentId: `${instance.contract.identity.source}:${instance.contract.identity.name}:${instance.contract.identity.version}`,
        reason,
        turnsTaken: instance.budgetStatus?.turnsUsed ?? 0,
        tokensUsed: instance.budgetStatus?.tokensUsed ?? 0,
      },
    });
  }
}
