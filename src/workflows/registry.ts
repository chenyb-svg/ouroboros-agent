// =============================================================================
// Workflow Registry — YAML loading + static validation (Phase 6+)
// =============================================================================

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dataPath } from "../data-home.js";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import type { WorkflowDefinition, WorkflowManifest } from "../types/workflow.js";
import type { AgentContract } from "../types/agents.js";

export class WorkflowRegistry {
  private workflows = new Map<string, WorkflowManifest>();
  private agentRegistry: Map<string, AgentContract>;

  constructor(agentContracts: AgentContract[]) {
    this.agentRegistry = new Map();
    for (const c of agentContracts) {
      const id = `${c.identity.source}:${c.identity.name}:${c.identity.version}`;
      this.agentRegistry.set(id, c);
    }
  }

  /** Discover workflows from project + user directories */
  discover(projectDir: string): void {
    // 1. Built-in workflows (none for now)
    // 2. User-level
    const userDir = dataPath("skills", "workflows");
    if (existsSync(userDir)) this.scanDirectory(userDir, "user");

    // 3. Project-level
    const projectDir2 = join(projectDir, ".ouroboros", "skills", "workflows");
    if (existsSync(projectDir2)) this.scanDirectory(projectDir2, "project");
  }

  /** Re-scan from scratch (clear + discover) so newly saved/deleted recipes take effect immediately. */
  reload(projectDir: string): void {
    this.workflows.clear();
    this.discover(projectDir);
  }

  /** Get a workflow by trigger */
  getByTrigger(trigger: string): WorkflowManifest | undefined {
    for (const wf of this.workflows.values()) {
      if (wf.definition.trigger === trigger) return wf;
    }
    return undefined;
  }

  /** Get a workflow by ID */
  get(id: string): WorkflowManifest | undefined {
    return this.workflows.get(id);
  }

  /** List all loaded workflows */
  listAll(): WorkflowManifest[] {
    return [...this.workflows.values()];
  }

  /** Fuzzy match for typo correction */
  suggestCorrection(input: string): string | undefined {
    const trigger = input.startsWith("/") ? input : `/${input}`;
    let bestMatch: string | undefined;
    let bestDist = Infinity;

    for (const wf of this.workflows.values()) {
      const dist = levenshtein(trigger, wf.definition.trigger);
      if (dist <= 2 && dist < bestDist) {
        bestDist = dist;
        bestMatch = wf.definition.trigger;
      }
    }
    return bestMatch;
  }

  /** Tab completion candidates */
  getCompletions(prefix: string): string[] {
    const p = prefix.startsWith("/") ? prefix : `/${prefix}`;
    return [...this.workflows.values()]
      .map((w) => w.definition.trigger)
      .filter((t) => t.startsWith(p));
  }

  /** Load a single YAML workflow file */
  private loadFile(path: string): WorkflowDefinition | null {
    try {
      const raw = readFileSync(path, "utf-8");
      return yaml.load(raw) as WorkflowDefinition;
    } catch {
      return null;
    }
  }

  private scanDirectory(dir: string, source: "user" | "project"): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml")) continue;

        const path = join(dir, entry.name);
        const def = this.loadFile(path);
        if (!def) continue;

        // Static validation
        const warnings = this.validate(def);

        // Content hash for change detection
        const raw = readFileSync(path, "utf-8");
        const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);

        // Conflict resolution
        const existing = this.workflows.get(def.id);
        if (existing) {
          // Keep highest priority (project > user)
          const priority = { project: 2, user: 1, builtin: 0 };
          if (priority[source] <= priority[existing.source]) continue;
        }

        this.workflows.set(def.id, {
          path,
          source,
          definition: def,
          loadedAt: Date.now(),
          contentHash: hash,
          warnings,
        });
      }
    } catch { /* directory read error */ }
  }

  private validate(def: WorkflowDefinition): string[] {
    const warnings: string[] = [];

    if (!def.trigger?.startsWith("/")) {
      warnings.push(`Trigger must start with "/": ${def.trigger}`);
    }
    if (!def.steps || def.steps.length === 0) {
      warnings.push("No steps defined");
    }
    if (def.steps.length > 7) {
      warnings.push(`Workflow has ${def.steps.length} steps — consider splitting`);
    }

    // Validate agent references
    for (const step of def.steps) {
      if (!this.agentRegistry.has(step.agent)) {
        warnings.push(`Agent "${step.agent}" not found in registry`);
      }
    }

    // Validate outputKey references
    const outputKeys = new Set<string>();
    for (const step of def.steps) {
      if (step.outputKey) outputKeys.add(step.outputKey);
    }
    for (const step of def.steps) {
      const refs = step.promptTemplate.match(/\{\{steps\[(\d+)\]\.output\.(\w+)\}\}/g);
      if (refs) {
        for (const ref of refs) {
          const key = ref.replace(/\{\{steps\[\d+\]\.output\.(\w+)\}\}/, "$1");
          if (!outputKeys.has(key)) {
            warnings.push(`Step "${step.id}" references undefined outputKey "${key}"`);
          }
        }
      }
    }

    return warnings;
  }
}

// Levenshtein distance for fuzzy matching
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
