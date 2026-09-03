// =============================================================================
// Workflow Types — Skill workflow definitions (Phase 6+)
// =============================================================================

import type { ToolFQN } from "./tools.js";
import type { BudgetSpec } from "./budget.js";

// ---- Execution Mode ----
export type WorkflowExecutionMode = "sequential" | "parallel" | "interactive";

// ---- Step Error Strategy ----
export type StepErrorStrategy =
  | { action: "abort" }
  | { action: "retry"; maxRetries: number }
  | { action: "fallback"; stepId: string };

// ---- Step Status ----
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "paused";

// ---- Workflow Definition ----
export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  trigger: string;            // e.g., "/review"
  version: string;
  type: WorkflowExecutionMode;
  extends?: string;           // inherit from another workflow
  inputSchema?: {
    parameters: Record<string, { type: string; required: boolean; description: string; default?: unknown }>;
    flags: Record<string, { type: "string" | "boolean" | "number"; short?: string; description: string; required?: boolean }>;
  };
  steps: WorkflowStep[];
  compatibleFrameworkVersions?: string;
}

export interface WorkflowStep {
  id: string;
  name: string;
  agent: string;              // Agent contract ID
  promptTemplate: string;     // Supports {{variable}} interpolation
  tools?: ToolFQN[];         // Authorized tools (overrides agent defaults)
  budget?: Partial<BudgetSpec>;
  outputKey?: string;         // Key in shared state for downstream steps
  condition?: string;         // Read-only expression: "$steps.step1.confidence == 'high'"
  onError?: StepErrorStrategy;
  dependsOn?: string[];       // Step IDs this step depends on (for parallel mode)
}

// ---- Runtime State ----
export interface WorkflowStepState {
  stepId: string;
  name: string;
  status: StepStatus;
  startedAt?: number;
  completedAt?: number;
  result?: { summary: string; confidence: string; artifacts?: string[] };
  error?: string;
  attempts: number;
  tokensUsed: number;
}

export interface WorkflowInstanceState {
  workflowId: string;
  instanceId: string;
  status: "running" | "paused" | "completed" | "failed";
  steps: WorkflowStepState[];
  currentStepIndex: number;
  sharedState: Record<string, unknown>;
  userFeedback?: string;
  startedAt: number;
  completedAt?: number;
}

// ---- Workflow Manifest ----
export interface WorkflowManifest {
  path: string;
  source: "builtin" | "user" | "project";
  definition: WorkflowDefinition;
  loadedAt: number;
  contentHash: string;
  warnings: string[];
}
