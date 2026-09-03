// =============================================================================
// Ouroboros Budget Types — Resource limits & enforcement
// =============================================================================

// ---- Budget Specification ---------------------------------------------------

export interface BudgetSpec {
  /** Maximum loop turns (INGEST→REASON→ACT cycles) */
  maxTurns: number;
  /** Maximum cumulative tokens (input + output) */
  maxTokens: number;
  /** Wall-clock timeout in milliseconds */
  timeoutMs: number;
  /** Maximum tool calls per individual tool type */
  maxToolCalls: Record<string, number>;
  /** Maximum files the agent is allowed to modify */
  maxFilesModified: number;
}

// ---- Budget Status ----------------------------------------------------------

export interface BudgetStatus {
  spec: BudgetSpec;
  turnsUsed: number;
  tokensUsed: number;
  startedAt: number;
  toolCallsByType: Record<string, number>;
  filesModified: string[];
  isExhausted: boolean;
  exhaustedReason?: BudgetExhaustedReason;
}

// ---- Budget Exhaustion ------------------------------------------------------

export type BudgetExhaustedReason =
  | "max_turns"
  | "max_tokens"
  | "timeout"
  | "max_tool_calls"
  | "max_files_modified";

// ---- Default Budgets --------------------------------------------------------

export const DEFAULT_COORDINATOR_BUDGET: BudgetSpec = {
  maxTurns: 50,
  maxTokens: 200_000,
  timeoutMs: 300_000, // 5 minutes
  maxToolCalls: {},
  maxFilesModified: 0, // Coordinator doesn't modify files
};

export const DEFAULT_WORKER_BUDGET: BudgetSpec = {
  maxTurns: 20,
  maxTokens: 100_000,
  timeoutMs: 120_000, // 2 minutes
  maxToolCalls: { "ouroboros:bash": 10, "ouroboros:write": 5 },
  maxFilesModified: 10,
};

export const DEFAULT_TOOL_AGENT_BUDGET: BudgetSpec = {
  maxTurns: 1,
  maxTokens: 10_000,
  timeoutMs: 30_000,
  maxToolCalls: {},
  maxFilesModified: 0,
};
