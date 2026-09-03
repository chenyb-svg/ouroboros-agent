// =============================================================================
// Agent Registry — Instance management, spawning, lookup
// =============================================================================

import { randomUUID } from "node:crypto";
import type { EventBus } from "../bus/event-bus.js";
import type { AgentContract, AgentInstance, AgentType } from "../types/agents.js";
import type { BudgetSpec } from "../types/budget.js";
import type { TranscriptWriter } from "../session/transcript.js";
import { AgentLifecycleManager } from "./lifecycle.js";

export class AgentRegistry {
  private contracts = new Map<string, AgentContract>();
  private lifecycle: AgentLifecycleManager;
  private bus: EventBus;
  private sessionId: string;
  private transcript: TranscriptWriter;

  constructor(
    bus: EventBus,
    lifecycle: AgentLifecycleManager,
    sessionId: string,
    transcript: TranscriptWriter,
  ) {
    this.bus = bus;
    this.lifecycle = lifecycle;
    this.sessionId = sessionId;
    this.transcript = transcript;
  }

  /**
   * Register a contract (from skill loading).
   */
  registerContract(contract: AgentContract): void {
    const id = `${contract.identity.source}:${contract.identity.name}:${contract.identity.version}`;
    this.contracts.set(id, contract);
  }

  /**
   * Get a contract by its string ID.
   */
  getContract(agentId: string): AgentContract | undefined {
    return this.contracts.get(agentId);
  }

  /**
   * List all registered contracts.
   */
  listContracts(): AgentContract[] {
    return [...this.contracts.values()];
  }

  /**
   * Spawn an agent instance from a contract.
   */
  spawn(
    agentId: string,
    options?: {
      parentInstanceId?: string;
      taskId?: string;
      budgetOverride?: Partial<BudgetSpec>;
    },
  ): AgentInstance | null {
    const contract = this.contracts.get(agentId);
    if (!contract) return null;

    const instanceId = randomUUID();

    const instance: AgentInstance = {
      instanceId,
      contract,
      state: "idle",
      spawnedAt: performance.now(),
      parentInstanceId: options?.parentInstanceId,
      taskId: options?.taskId,
      sidechainPath: `sidechains/${instanceId}/`,
    };

    this.lifecycle.register(instance);
    return instance;
  }

  /**
   * Activate an instance — transition to active state.
   */
  activate(instanceId: string): boolean {
    return this.lifecycle.transition(instanceId, "active", "task_started");
  }

  /**
   * Terminate an instance.
   */
  terminate(instanceId: string, reason: string): boolean {
    // First transition to terminating
    this.lifecycle.transition(instanceId, "terminating", reason);
    // Then to terminated
    return this.lifecycle.transition(instanceId, "terminated", reason);
  }

  /**
   * Get an instance.
   */
  get(instanceId: string): AgentInstance | undefined {
    return this.lifecycle.get(instanceId);
  }

  /**
   * List instances by criteria.
   */
  listInstances(filter?: {
    state?: string;
    type?: string;
    parentInstanceId?: string;
  }): AgentInstance[] {
    return this.lifecycle.list(
      filter as {
        state?: import("../types/agents.js").AgentLifecycleState;
        type?: string;
        parentInstanceId?: string;
      },
    );
  }

  /**
   * Count of active agents.
   */
  activeCount(): number {
    return this.lifecycle.activeCount();
  }
}
