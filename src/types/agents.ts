// =============================================================================
// Ouroboros Agent Contract & Identity Types
// Every agent entity must satisfy this contract before joining the system.
// =============================================================================

// ---- Agent Identity ---------------------------------------------------------

/** Globally unique agent ID: {source}:{name}:{version} */
export type AgentId = string; // e.g. "builtin:coordinator:v1"

export interface AgentIdentity {
  source: string;       // "builtin" | "claude-code" | "openclaw" | "mcp"
  name: string;         // "coordinator" | "reviewer" | "planner"
  version: string;      // "v1" | "v2"
  displayName: string;  // human-facing label
  description: string;  // for Coordinator intent-matching
}

export function agentIdToString(id: AgentIdentity): AgentId {
  return `${id.source}:${id.name}:${id.version}`;
}

export function parseAgentId(id: AgentId): AgentIdentity {
  const parts = id.split(":");
  if (parts.length < 3) throw new Error(`Invalid agent ID: ${id}`);
  return {
    source: parts[0],
    name: parts.slice(1, -1).join(":"),
    version: parts[parts.length - 1],
    displayName: parts.slice(1, -1).join(":"),
    description: "",
  };
}

// ---- Agent Capabilities -----------------------------------------------------

export interface AgentCapabilities {
  canReadFiles: boolean;
  canWriteFiles: boolean;
  canExecuteBash: boolean;
  canDelegate: boolean;       // can spawn sub-agents
  canModifyContext: boolean;  // can write shared state or modify CLAUDE.md
  preferredModel?: {
    provider: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
  };
  /** Tools this agent brings (FQN format) */
  providedTools: string[];
  /** Domain tags for Coordinator matching */
  domainTags: string[];
}

// ---- Agent Type Enum --------------------------------------------------------

export type AgentType = "Coordinator" | "Worker" | "Specialist" | "ToolAgent";

// ---- Context Policy ---------------------------------------------------------

export type ContextPolicyLevel = "none" | "snapshot" | "clean";

export interface ContextPolicy {
  level: ContextPolicyLevel;
  /** For "snapshot": max messages to include in the snapshot */
  maxSnapshotMessages?: number;
  /** System prompt to inject when using "clean" policy */
  cleanSystemPrompt?: string;
}

// ---- Lifecycle Hooks --------------------------------------------------------

export interface LifecycleHooks {
  onLoad?: () => Promise<void> | void;
  onActivate?: () => Promise<void> | void;
  onPause?: () => Promise<void> | void;
  onTeardown?: () => Promise<void> | void;
}

// ---- Agent Contract ---------------------------------------------------------

export interface AgentContract {
  identity: AgentIdentity;
  type: AgentType;
  capabilities: AgentCapabilities;
  contextPolicy: ContextPolicy;
  /** System prompt for the agent */
  systemPrompt: string;
  /** Default budget if not overridden by Coordinator */
  defaultBudget?: import("./budget.js").BudgetSpec;
  /** Validation errors found during loading */
  validationErrors?: string[];
}

// ---- Agent Instance ---------------------------------------------------------

export type AgentLifecycleState =
  | "discovered"
  | "loaded"
  | "idle"
  | "active"
  | "paused"
  | "terminating"
  | "terminated"
  | "archived";

export interface AgentInstance {
  instanceId: string;
  contract: AgentContract;
  state: AgentLifecycleState;
  spawnedAt: number;
  parentInstanceId?: string;    // which agent spawned this one
  taskId?: string;              // task this agent is working on
  budgetStatus?: import("./budget.js").BudgetStatus;
  sidechainPath?: string;
}
