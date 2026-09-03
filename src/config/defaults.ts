// =============================================================================
// Ouroboros Config Defaults — Hardcoded sensible baseline (Phase 3)
// =============================================================================

import type { OuroborosConfig } from "../types/config.js";
import { dataPath } from "../data-home.js";
import { join } from "node:path";
import { DEFAULT_WORKER_BUDGET, DEFAULT_COORDINATOR_BUDGET } from "../types/budget.js";

export function getDefaults(): OuroborosConfig {
  return {
    version: 1,
    // Legacy model config (auto-converted to provider during loading)
    model: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      temperature: 0.7,
      maxTokens: 8192,
      // Real context window (prompt + completion), NOT the output cap. The token
      // ring and pre-call auto-compaction divide by this. Tune per model card.
      contextWindow: 131072,
      apiEndpoint: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    },
    // Phase 3: Provider-based config
    providers: [
      {
        name: "deepseek",
        type: "openai",
        apiKey: "${DEEPSEEK_API_KEY}",
        baseUrl: "https://api.deepseek.com",
        models: ["deepseek-v4-flash", "deepseek-v4-pro"],
      },
    ],
    // Phase 3: Model overrides — Coordinator uses pro, Workers use flash
    modelOverrides: {
      "builtin:coordinator": {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        temperature: 0.3,
        maxTokens: 8192,
        contextWindow: 131072,
      },
      Worker: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        temperature: 0.1,
        maxTokens: 4096,
        contextWindow: 131072,
      },
    },
    terminal: {
      theme: "dark",
      colorLevel: "auto",
      animation: true,
      layout: {
        showStatusBar: true,
        showSessionId: true,
        showContextUsage: true,
        showModelName: true,
        statusBarPosition: "top",
      },
    },
    permissions: {
      defaultMode: "ask",
      dangerousCommands: [
        "rm\\s+(-rf?\\s+)?/",
        "git\\s+push\\s+--force",
        "DROP\\s+TABLE",
        "DELETE\\s+FROM",
        "sudo\\s+",
        "chmod\\s+777",
      ],
    },
    agents: {
      dir: "./.ouroboros/agents/",
      defaultCoordinator: "coordinator",
      defaultWorkerBudget: DEFAULT_WORKER_BUDGET,
      defaultCoordinatorBudget: DEFAULT_COORDINATOR_BUDGET,
    },
    storage: {
      sessionsDir: dataPath("sessions"),
      transcriptFormat: "jsonl",
      maxSessionSizeBytes: 100 * 1024 * 1024,
    },
    skillImports: [],
    toolAliases: {},
    contextMerge: { strategy: "append" },
    garbageCollection: {
      terminatedRetentionMinutes: 5,
      archivedRetentionDays: 7,
      sweepIntervalMinutes: 10,
    },
    // Phase 5
    mcpServers: [],
    plugins: [],
    virtualization: {
      bash: { enabled: true, timeoutMs: 30000 },
      network: { blockedDomains: [] },
    },
    security: {
      // workspaceRoot defaults to cwd at runtime; keep explicit for cross-machine configs
      allowedWritePaths: [],
      promptInjection: "tag",
    },
    recipes: {
      autoLearn: true,
      sessionAutoLearn: true, // summarize the whole session into recipes at exit
    },
  };
}
