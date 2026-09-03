// =============================================================================
// Auto-Learn Recipes (P2)
// After a complex task completes, learn a reusable recipe from the turn's
// execution trace: dedup against the library, and auto-update an existing
// auto-learned recipe when a simpler equivalent workflow is found. Manual
// recipes are never overwritten.
// =============================================================================

import { readFileSync } from "node:fs";
import type { WorkflowManifest } from "../types/workflow.js";
import { slugify, saveExecutionRecipe, normalizeToolFqn } from "./recipe-save.js";

export interface TurnAnalysis {
  toolCallCount: number;
  toolFqns: string[];
}

/** Count tool calls + collect the distinct ouroboros fqns used in a turn. */
export function analyzeTurn(turnMessages: any[]): TurnAnalysis {
  let toolCallCount = 0;
  const fqns = new Set<string>();
  for (const m of turnMessages) {
    if (m?.role === "assistant" && Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        const fqn = normalizeToolFqn(tc?.function?.name || tc?.name);
        toolCallCount++;
        if (fqn.startsWith("ouroboros:")) fqns.add(fqn);
      }
    }
  }
  return { toolCallCount, toolFqns: [...fqns] };
}

/** Marker written at the top of every auto-learned recipe YAML. */
export const AUTO_MARKER = "# auto-learned by ouroboros";

/** True if the recipe file was written by the auto-learn machinery. */
export function isAutoLearned(manifest: WorkflowManifest): boolean {
  try {
    return readFileSync(manifest.path, "utf-8").includes(AUTO_MARKER);
  } catch {
    return false;
  }
}

/** First sentence of the input (cut at sentence punctuation), truncated. */
export function recipeNameFrom(input: string, max = 30): string {
  const first = input.split(/[，。！？;；,]/)[0].trim();
  return (first || input).slice(0, max);
}

/** Tokenize for overlap: ASCII words + individual CJK chars. */
export function tokens(s: string): Set<string> {
  return new Set(String(s).toLowerCase().match(/[a-z0-9]+|[一-鿿]/g) ?? []);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Complexity = total steps + total tool references (lower = simpler). */
export function recipeComplexity(def: { steps: Array<{ tools?: string[] }> }): number {
  return def.steps.reduce((sum, s) => sum + 1 + (s.tools?.length ?? 0), 0);
}

export interface AutoLearnPlan {
  action: "save" | "update" | "skip-complex" | "skip-duplicate" | "not-complex";
  name: string;
  description: string;
  id: string;
  trigger: string;
  existingTrigger?: string;
  reason?: string;
  existing?: WorkflowManifest;
}

/**
 * Decide what to do with a just-completed turn. Pure decision (reads existing
 * recipe files only to check the auto-learned marker). Caller persists via
 * executeAutoLearn when action is "save" or "update".
 */
export function planAutoLearn(
  input: string,
  turnMessages: any[],
  existing: WorkflowManifest[],
): AutoLearnPlan {
  const { toolCallCount, toolFqns } = analyzeTurn(turnMessages);
  const name = recipeNameFrom(input);
  const description = input.slice(0, 120);
  const id = slugify(name);
  const trigger = `/${id}`;
  const base = { name, description, id, trigger };

  // 1. Not complex enough to learn from (chat, single lookup, etc.)
  if (toolCallCount < 3 || toolFqns.length < 2) {
    return { action: "not-complex", ...base, reason: `${toolCallCount} calls / ${toolFqns.length} tool types` };
  }

  // New recipe complexity: 1 + distinct tools per assistant tool-round (matches
  // how generateDraftFromExecution turns rounds into steps, capped at 6).
  const rounds = turnMessages
    .filter((m) => m?.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.length > 0)
    .slice(0, 6);
  const newComplexity = rounds.reduce(
    (sum, m) => sum + 1 + new Set(m.toolCalls.map((tc: any) => normalizeToolFqn(tc?.function?.name || tc?.name))).size,
    0,
  );

  // 2. Exact id/trigger match → update candidate
  const exact = existing.find((m) => m.definition.id === id || m.definition.trigger === trigger);
  if (exact) {
    const oldComplexity = recipeComplexity(exact.definition);
    if (isAutoLearned(exact) && newComplexity <= oldComplexity) {
      return {
        action: "update",
        ...base,
        existing: exact,
        existingTrigger: exact.definition.trigger,
        reason: `simpler (${newComplexity} <= ${oldComplexity})`,
      };
    }
    return {
      action: "skip-complex",
      ...base,
      existing: exact,
      existingTrigger: exact.definition.trigger,
      reason: `existing is simpler or manually maintained (${oldComplexity} < ${newComplexity})`,
    };
  }

  // 3. Near-duplicate by name overlap (same intent, different wording)
  const nameTokens = tokens(name);
  for (const m of existing) {
    const otherTokens = tokens(m.definition.name);
    const overlap = jaccard(nameTokens, otherTokens);
    const shorter = Math.min(nameTokens.size, otherTokens.size);
    if (overlap >= 0.6 && shorter >= 4) {
      return {
        action: "skip-duplicate",
        ...base,
        existing: m,
        existingTrigger: m.definition.trigger,
        reason: `${overlap.toFixed(2)} overlap with ${m.definition.trigger}`,
      };
    }
  }

  return { action: "save", ...base };
}

/** Write the auto-learned recipe YAML; returns the saved path. */
export function executeAutoLearn(
  input: string,
  turnMessages: any[],
  name: string,
  dir?: string,
): string {
  const description = input.slice(0, 120);
  return saveExecutionRecipe(turnMessages, name, description, dir);
}
