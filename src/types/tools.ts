// =============================================================================
// Ouroboros Tool Registry Types — FQN, ToolDefinition, Visibility
// =============================================================================

// ---- Tool FQN ---------------------------------------------------------------

/**
 * Fully Qualified Name: {namespace}:{tool_name}
 * Examples: "ouroboros:read", "claude-code:review", "mcp:github:search"
 */
export type ToolFQN = string;

export interface ParsedFQN {
  namespace: string;
  toolName: string;
}

// ---- Tool Definition --------------------------------------------------------

export type ToolParamType = "string" | "number" | "boolean" | "object" | "array";

export interface ToolParamSchema {
  name: string;
  type: ToolParamType;
  required: boolean;
  description: string;
  default?: unknown;
  enum?: string[];
}

export interface ToolDefinition {
  fqn: ToolFQN;
  description: string;
  parameters: ToolParamSchema[];
  /** Which agent type(s) this tool is available to by default */
  defaultVisibility: "all" | "Coordinator" | "Worker" | "Specialist" | "ToolAgent" | "none";
  /** Whether this tool is considered dangerous (requires permission) */
  dangerous: boolean;
  /** Source: builtin, skill, mcp, dynamic */
  source: ToolSource;
  /** The actual implementation (async function) */
  execute: (args: Record<string, unknown>, agentContext: unknown) => Promise<ToolResult>;
}

export type ToolSource = "builtin" | "skill" | "mcp" | "dynamic";

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  /** Files modified by this tool (for BudgetEnforcer tracking) */
  modifiedFiles?: string[];
  /** Inode changes tracked */
  inodeChanges?: Array<{ path: string; before: string; after: string }>;
}

// ---- Tool Visibility --------------------------------------------------------

export interface ToolVisibilityMatrix {
  agentId: string;
  visibleTools: ToolFQN[];
  /** Tools explicitly blocked even if visible by default */
  blockedTools: ToolFQN[];
}

// ---- Tool Override ----------------------------------------------------------

export interface ToolOverride {
  /** The FQN being overridden */
  original: ToolFQN;
  /** The FQN to use instead */
  replacement: ToolFQN;
  /** Reason for the override */
  reason: string;
}

// ---- Tool Alias Map ---------------------------------------------------------

export type ToolAliasMap = Record<string, ToolFQN>;
