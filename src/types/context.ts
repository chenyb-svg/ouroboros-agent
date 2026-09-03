// =============================================================================
// Ouroboros Context Protocol — Unified message format for cross-agent comms
// =============================================================================

// ---- Extended Roles ---------------------------------------------------------

export type MessageRole =
  | "system"
  | "user"
  | "assistant"
  | "tool"
  | "observer"
  | "delegate";

// ---- Message Intent ---------------------------------------------------------

export type MessageIntent =
  | "task_assignment"
  | "result_report"
  | "clarification_request"
  | "budget_warning"
  | "status_update"
  | "none";

// ---- Unified Message --------------------------------------------------------

export interface UnifiedMessage {
  /** Message role */
  role: MessageRole;
  /** Text content */
  content: string;
  /** Which agent produced this message */
  agentId: string;
  /** Parent agent ID (for building call tree) */
  parentAgentId?: string;
  /** Intent tag */
  intent: MessageIntent;
  /** Causal chain ID (traces back to originating USER_INPUT) */
  causalChainId: string;
  /** Timestamp */
  timestamp: number;
  /** Whether this message is private (other agents cannot see it) */
  private: boolean;
  /** Tool call ID (for tool role messages) */
  toolCallId?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// ---- Delegation Message -----------------------------------------------------

export interface DelegationMessage extends UnifiedMessage {
  role: "delegate";
  intent: "task_assignment";
  payload: {
    taskId: string;
    taskDescription: string;
    expectedDeliverable: "diff" | "summary" | "test-report" | "file-content" | "generic";
    authorizedTools: string[];   // FQN array
    budget: import("./budget.js").BudgetSpec;
    contextSnapshot?: UnifiedMessage[];  // for "snapshot" policy
  };
}

// ---- Result Report ----------------------------------------------------------

export interface ResultReportMessage extends UnifiedMessage {
  role: "delegate";
  intent: "result_report";
  payload: {
    taskId: string;
    success: boolean;
    summary: string;             // Worker's LLM summary, not raw tool output
    rawOutput?: string;          // optional raw tool output (collapsed in TUI)
    filesModified?: string[];
    tokensUsed: number;
    turnsTaken: number;
    errors?: string[];
  };
}

// ---- Context Assembly Config ------------------------------------------------

export type ContextMergeStrategy = "prepend" | "append" | "override";

export interface ContextAssemblyConfig {
  mergeStrategy: ContextMergeStrategy;
  /** Files to inject as project context */
  projectContextFiles?: string[];
  /** Shared state keys to inject */
  sharedStateKeys?: string[];
}
