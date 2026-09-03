// =============================================================================
// Unified Message Builders — Construct messages with agent semantic fields
// =============================================================================

import { randomUUID } from "node:crypto";
import type {
  UnifiedMessage,
  DelegationMessage,
  ResultReportMessage,
  MessageRole,
  MessageIntent,
} from "../types/context.js";
import type { BudgetSpec } from "../types/budget.js";
import type { ToolFQN } from "../types/tools.js";

/**
 * Create a standard unified message.
 */
export function createMessage(params: {
  role: MessageRole;
  content: string;
  agentId: string;
  parentAgentId?: string;
  intent?: MessageIntent;
  causalChainId?: string;
  private?: boolean;
  metadata?: Record<string, unknown>;
}): UnifiedMessage {
  return {
    role: params.role,
    content: params.content,
    agentId: params.agentId,
    parentAgentId: params.parentAgentId,
    intent: params.intent ?? "none",
    causalChainId: params.causalChainId ?? randomUUID(),
    timestamp: performance.now(),
    private: params.private ?? false,
    metadata: params.metadata,
  };
}

/**
 * Create a delegation message (Coordinator → Worker).
 */
export function createDelegationMessage(params: {
  taskId: string;
  taskDescription: string;
  expectedDeliverable: DelegationMessage["payload"]["expectedDeliverable"];
  authorizedTools: ToolFQN[];
  budget: BudgetSpec;
  coordinatorAgentId: string;
  targetAgentId: string;
  causalChainId: string;
  contextSnapshot?: UnifiedMessage[];
}): DelegationMessage {
  return {
    role: "delegate",
    content: params.taskDescription,
    agentId: params.coordinatorAgentId,
    parentAgentId: params.coordinatorAgentId,
    intent: "task_assignment",
    causalChainId: params.causalChainId,
    timestamp: performance.now(),
    private: false,
    payload: {
      taskId: params.taskId,
      taskDescription: params.taskDescription,
      expectedDeliverable: params.expectedDeliverable,
      authorizedTools: params.authorizedTools,
      budget: params.budget,
      contextSnapshot: params.contextSnapshot,
    },
  };
}

/**
 * Create a result report message (Worker → Coordinator).
 */
export function createResultReport(params: {
  taskId: string;
  success: boolean;
  summary: string;
  workerAgentId: string;
  coordinatorAgentId: string;
  causalChainId: string;
  rawOutput?: string;
  filesModified?: string[];
  tokensUsed: number;
  turnsTaken: number;
  errors?: string[];
}): ResultReportMessage {
  return {
    role: "delegate",
    content: params.summary,
    agentId: params.workerAgentId,
    parentAgentId: params.coordinatorAgentId,
    intent: "result_report",
    causalChainId: params.causalChainId,
    timestamp: performance.now(),
    private: false,
    payload: {
      taskId: params.taskId,
      success: params.success,
      summary: params.summary,
      rawOutput: params.rawOutput,
      filesModified: params.filesModified,
      tokensUsed: params.tokensUsed,
      turnsTaken: params.turnsTaken,
      errors: params.errors,
    },
  };
}

/**
 * Create a system message (for control flow).
 */
export function createSystemMessage(params: {
  content: string;
  agentId: string;
  causalChainId?: string;
}): UnifiedMessage {
  return {
    role: "system",
    content: params.content,
    agentId: params.agentId,
    intent: "none",
    causalChainId: params.causalChainId ?? randomUUID(),
    timestamp: performance.now(),
    private: true,
  };
}
