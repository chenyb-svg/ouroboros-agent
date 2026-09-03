// =============================================================================
// Ouroboros Config — The constitution (Phase 5 extended)
// =============================================================================

import type { SkillImport } from "./skills.js";
import type { BudgetSpec } from "./budget.js";
import type { ContextMergeStrategy } from "./context.js";
import type { McpServerConfig } from "./mcp.js";

export type ColorLevel = 16 | 256 | "truecolor";
export type PermissionMode = "ask" | "accept-edits" | "bypass";
export type ThemeVariant = "dark" | "light";

// ---- Phase 3: Provider & Model Config ---------------------------------------

export type ProviderType = "openai" | "anthropic" | "ollama" | "deepseek";

export interface ProviderConfig {
  name: string;            // "deepseek"
  type: ProviderType;      // "openai" (DeepSeek uses OpenAI-compatible API)
  apiKey: string;          // "${DEEPSEEK_API_KEY}" — resolved at load time
  baseUrl: string;         // "https://api.deepseek.com"
  models: string[];        // ["deepseek-v4-flash", "deepseek-v4-pro"]
}

export interface ModelOverride {
  provider: string;        // "deepseek"
  model: string;           // "deepseek-v4-pro"
  temperature?: number;
  maxTokens?: number;
  /**
   * The model's REAL context window in tokens (prompt + completion). This is what
   * the token ring divides by and what pre-call auto-compaction is measured
   * against. `maxTokens` is only the per-response OUTPUT cap (max_tokens) and is
   * NOT the context length. Falls back to the top-level `model.contextWindow`.
   */
  contextWindow?: number;
}

// Legacy: keep old ModelConfig for backward compat, auto-converted to ProviderConfig
export interface ModelConfig {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  apiEndpoint: string;
  apiKeyEnv: string;
  /** Real context window (tokens) — see ModelOverride.contextWindow. */
  contextWindow?: number;
}

export interface TerminalConfig {
  theme: ThemeVariant;
  colorLevel: ColorLevel | "auto";
  animation: boolean;
  layout: {
    showStatusBar: boolean;
    showSessionId: boolean;
    showContextUsage: boolean;
    showModelName: boolean;
    statusBarPosition: "top" | "bottom";
  };
}

export interface PermissionsConfig {
  defaultMode: PermissionMode;
  dangerousCommands: string[];
}

export interface AgentsConfig {
  dir: string;
  defaultCoordinator: string;
  defaultWorkerBudget: BudgetSpec;
  defaultCoordinatorBudget: BudgetSpec;
}

export interface StorageConfig {
  sessionsDir: string;
  transcriptFormat: "jsonl";
  maxSessionSizeBytes: number;
}

export interface GcConfig {
  terminatedRetentionMinutes: number;
  archivedRetentionDays: number;
  sweepIntervalMinutes: number;
}

export interface ContextMergeConfig {
  strategy: ContextMergeStrategy;
  fieldStrategies?: Record<string, ContextMergeStrategy>;
}

export type PromptInjectionMode = "tag" | "strip" | "off";

export interface SecurityConfig {
  workspaceRoot?: string;            // agent-visible workspace; writes outside need permission
  allowedWritePaths?: string[];      // prefix-matched paths allowed even outside workspaceRoot
  promptInjection?: PromptInjectionMode; // how to handle suspected prompt-injection in external content
}

export interface RecipesConfig {
  autoLearn?: boolean; // auto-learn a recipe after complex tasks (default true)
  sessionAutoLearn?: boolean; // summarize the whole session into recipes at exit (default true)
}

export interface OuroborosConfig {
  version: number;
  // Legacy: single model config (auto-converted during loading)
  model: ModelConfig;
  // Phase 3: provider-based config
  providers: ProviderConfig[];
  // Phase 3: per-agent or per-type model overrides
  modelOverrides: Record<string, ModelOverride>;
  terminal: TerminalConfig;
  permissions: PermissionsConfig;
  agents: AgentsConfig;
  storage: StorageConfig;
  skillImports: SkillImport[];
  toolAliases: Record<string, string>;
  contextMerge: ContextMergeConfig;
  garbageCollection: GcConfig;
  // Phase 5
  mcpServers: McpServerConfig[];
  plugins: string[];
  virtualization: {
    bash: { enabled: boolean; timeoutMs: number };
    network: { blockedDomains: string[] };
  };
  security: SecurityConfig;
  recipes: RecipesConfig;
}

export type PartialOuroborosConfig = Partial<{
  version: number;
  model: Partial<ModelConfig>;
  providers: ProviderConfig[];
  modelOverrides: Record<string, ModelOverride>;
  terminal: Partial<TerminalConfig>;
  permissions: Partial<PermissionsConfig>;
  agents: Partial<AgentsConfig>;
  storage: Partial<StorageConfig>;
  skillImports: SkillImport[];
  toolAliases: Record<string, string>;
  contextMerge: Partial<ContextMergeConfig>;
  garbageCollection: Partial<GcConfig>;
  mcpServers: McpServerConfig[];
  plugins: string[];
  virtualization: Partial<{ bash: { enabled: boolean; timeoutMs: number }; network: { blockedDomains: string[] } }>;
  security: Partial<SecurityConfig>;
  recipes: Partial<RecipesConfig>;
}>;
