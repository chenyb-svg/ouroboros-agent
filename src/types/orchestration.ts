// =============================================================================
// Ouroboros Orchestration Types — Coordinator-Worker delegation & task tracking
// =============================================================================

import type { ToolFQN } from "./tools.js";
import type { AgentId } from "./agents.js";

// ---- Task Status ------------------------------------------------------------

export type TaskStatus = "pending" | "claimed" | "active" | "completed" | "failed";

// ---- Task Entry -------------------------------------------------------------

export interface TaskEntry {
  taskId: string;
  parentTaskId?: string;       // for building task tree
  description: string;
  assignedAgentId?: AgentId;   // Worker assigned to this task
  status: TaskStatus;
  expectedDeliverable: "diff" | "summary" | "test-report" | "file-content" | "generic";
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  resultSummary?: string;
  errorMessage?: string;
}

// ---- Delegation Spec --------------------------------------------------------

export interface DelegationSpec {
  taskId: string;
  taskDescription: string;
  expectedDeliverable: "diff" | "summary" | "test-report" | "file-content" | "generic";
  authorizedTools: ToolFQN[];
  targetAgentId: AgentId;
  budget: import("./budget.js").BudgetSpec;
}

// ---- Result Aggregation -----------------------------------------------------

export interface AggregatedResult {
  userResponse: string;        // what to show the user
  taskResults: Array<{
    taskId: string;
    agentId: AgentId;
    success: boolean;
    summary: string;
  }>;
  hasConflicts: boolean;
  conflictDescription?: string;
}

// ---- Coordinator Decision ---------------------------------------------------

export type CoordinatorDecision =
  | { kind: "direct_answer"; text: string }
  | { kind: "delegate"; delegation: DelegationSpec }
  | { kind: "clarify"; question: string }
  | { kind: "multi_delegate"; delegations: DelegationSpec[] }
  | { kind: "workflow"; workflowId: string; input: Record<string, unknown> };
