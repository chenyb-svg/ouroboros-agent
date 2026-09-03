// =============================================================================
// Session-Level Auto-Learn (P3)
// At session end the whole conversation is summarized by an LLM into reusable
// workflow recipes: parsed to strict JSON → deduped against the library → saved
// or auto-updated (manual recipes are never overwritten). The LLM call itself
// lives in repl.ts; this module is pure parsing/planning/emitting + the final
// write, so it is fully unit-testable.
// =============================================================================

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowManifest } from "../types/workflow.js";
import { slugify, normalizeToolFqn } from "./recipe-save.js";
import { recipeComplexity, isAutoLearned, tokens, jaccard } from "./auto-learn.js";

export interface SessionRecipeStep {
  prompt: string;
  tools?: string[];
}

export interface SessionRecipeCandidate {
  name: string;
  description: string;
  steps: SessionRecipeStep[];
}

// ---- Transcript building ---------------------------------------------------

/**
 * Compress conversation history into a compact transcript for the LLM:
 * user/assistant content snippets, tool results heavily truncated, and the
 * tail kept when the history exceeds maxChars (recent activity matters most).
 */
export function buildSessionTranscript(conversationHistory: any[], maxChars = 12000): string {
  const lines: string[] = [];
  for (const m of conversationHistory ?? []) {
    const role = m?.role;
    if (role === "user") {
      lines.push(`U: ${String(m.content ?? "").replace(/\s+/g, " ").trim().slice(0, 300)}`);
    } else if (role === "assistant") {
      const tools = Array.isArray(m.toolCalls)
        ? m.toolCalls
            .map((tc: any) => normalizeToolFqn(tc?.function?.name || tc?.name))
            .filter((f: string) => f.startsWith("ouroboros:"))
        : [];
      const content = String(m.content ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
      lines.push(`A: ${content}${tools.length ? ` [tools: ${tools.join(", ")}]` : ""}`);
    } else if (role === "tool") {
      lines.push(`T: ${String(m.content ?? "").replace(/\s+/g, " ").trim().slice(0, 160)}`);
    }
  }

  let transcript = lines.join("\n");
  if (transcript.length > maxChars) {
    const tail: string[] = [];
    let acc = "";
    for (let i = lines.length - 1; i >= 0; i--) {
      const add = (acc ? "\n" : "") + lines[i];
      if (acc.length + add.length > maxChars) break;
      acc += add;
      tail.unshift(lines[i]);
    }
    transcript = "[earlier messages omitted]\n" + tail.join("\n");
  }
  return transcript;
}

// ---- LLM system prompt -----------------------------------------------------

export const SESSION_SUMMARY_SYSTEM = `You are Ouroboros's recipe-extraction engine. Given a session transcript,
extract the reusable multi-step workflows the user might repeat, and output them as JSON.

RULES:
- Only extract workflows that are genuinely reusable and multi-step (e.g. research-a-topic,
  refactor-with-checks). Skip chat, one-off lookups, and trivial actions.
- Output NO prose and NO markdown fences — only valid JSON in this exact shape:
  {"recipes":[{"name":"short trigger phrase (<=20 chars)","description":"specific description of WHEN this recipe applies (used to auto-match future tasks)","steps":[{"prompt":"concrete instruction for this step","tools":["ouroboros:search"]}]}]}
- Each recipe: 2-6 steps. tools must be real ouroboros:* FQNs seen in the transcript
  (e.g. ouroboros:search, ouroboros:read, ouroboros:grep, ouroboros:write, ouroboros:bash,
  ouroboros:run_recipe, ouroboros:delegate). Omit the tools field if the step needs none.
- name should be a short phrase the user might type, e.g. "调研技术话题".
- At most 5 recipes.`;

// ---- Parsing ---------------------------------------------------------------

/** Parse the LLM's reply into validated recipe candidates (max 5). */
export function parseSessionRecipes(llmText: string): SessionRecipeCandidate[] {
  const out: SessionRecipeCandidate[] = [];
  const text = String(llmText ?? "");
  if (!text.trim()) return out;

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const obj = text.match(/\{[\s\S]*\}/);
  let parsed: any = null;
  for (const candidate of [fence?.[1], obj?.[0], text]) {
    if (!candidate) continue;
    try {
      parsed = JSON.parse(candidate.trim());
      if (parsed) break;
    } catch {
      /* try next form */
    }
  }

  const rawRecipes = Array.isArray(parsed) ? parsed : parsed?.recipes;
  if (!Array.isArray(rawRecipes)) return out;

  for (const r of rawRecipes.slice(0, 5)) {
    if (!r || typeof r !== "object") continue;
    const name = String(r.name ?? "").trim();
    const description = String(r.description ?? "").trim();
    if (!name || !Array.isArray(r.steps)) continue;

    const steps: SessionRecipeStep[] = [];
    for (const s of (r.steps as any[]).slice(0, 6)) {
      const prompt = String(s?.prompt ?? "").trim();
      if (!prompt) continue;
      const tools: string[] | undefined = Array.isArray(s?.tools)
        ? [...new Set((s.tools as any[]).map((t: any) => normalizeToolFqn(String(t).trim())).filter((t: string) => t.startsWith("ouroboros:")))]
        : undefined;
      steps.push(tools && tools.length ? { prompt, tools } : { prompt });
    }
    if (steps.length === 0) continue;
    out.push({ name: name.slice(0, 30), description: description.slice(0, 160), steps });
  }
  return out;
}

// ---- Planning --------------------------------------------------------------

export interface SessionLearnPlan {
  action: "save" | "update" | "skip-complex" | "skip-duplicate";
  id: string;
  trigger: string;
  existingTrigger?: string;
  reason?: string;
}

/** Dedup + auto-update decision for one LLM-derived candidate (same policy as P2). */
export function planSessionRecipe(candidate: SessionRecipeCandidate, existing: WorkflowManifest[]): SessionLearnPlan {
  const id = slugify(candidate.name);
  const trigger = `/${id}`;
  const base = { id, trigger };
  const newComplexity = candidate.steps.reduce((sum, s) => sum + 1 + (s.tools?.length ?? 0), 0);

  const exact = existing.find((m) => m.definition.id === id || m.definition.trigger === trigger);
  if (exact) {
    const old = recipeComplexity(exact.definition);
    if (isAutoLearned(exact) && newComplexity <= old) {
      return {
        action: "update",
        ...base,
        existingTrigger: exact.definition.trigger,
        reason: `simpler (${newComplexity} <= ${old})`,
      };
    }
    return {
      action: "skip-complex",
      ...base,
      existingTrigger: exact.definition.trigger,
      reason: `existing is simpler or manually maintained (${old} < ${newComplexity})`,
    };
  }

  const nameTokens = tokens(candidate.name);
  for (const m of existing) {
    const otherTokens = tokens(m.definition.name);
    const overlap = jaccard(nameTokens, otherTokens);
    const shorter = Math.min(nameTokens.size, otherTokens.size);
    if (overlap >= 0.6 && shorter >= 4) {
      return {
        action: "skip-duplicate",
        ...base,
        existingTrigger: m.definition.trigger,
        reason: `${overlap.toFixed(2)} overlap with ${m.definition.trigger}`,
      };
    }
  }

  return { action: "save", ...base };
}

// ---- YAML emission ---------------------------------------------------------

function esc(s: string): string {
  return s.replace(/"/g, "'").replace(/\\/g, "\\\\");
}

/** Emit a registry-loadable recipe YAML (same shape as generateDraftFromExecution). */
export function emitSessionRecipeYAML(candidate: SessionRecipeCandidate): string {
  const id = slugify(candidate.name);
  const steps = candidate.steps.slice(0, 6);

  const L: string[] = [];
  L.push(`# auto-learned by ouroboros`);
  L.push(`id: ${id}`);
  L.push(`name: "${esc(candidate.name)}"`);
  L.push(`description: "${esc(candidate.description || "Reusable workflow")}"`);
  L.push(`trigger: "/${id}"`);
  L.push(`version: "0.1.0"`);
  L.push(`type: sequential`);
  L.push(`steps:`);

  if (steps.length === 0) {
    L.push(`  - id: step1`);
    L.push(`    name: "${esc(candidate.name.slice(0, 48))}"`);
    L.push(`    agent: "builtin:coordinator:v1"`);
    L.push(`    promptTemplate: |-`);
    L.push(`      Complete the requested task and report the result.`);
  } else {
    for (const [i, s] of steps.entries()) {
      const title = (s.prompt.split("\n")[0] || `Step ${i + 1}`).slice(0, 48);
      L.push(`  - id: step${i + 1}`);
      L.push(`    name: "${esc(title)}"`);
      L.push(`    agent: "builtin:coordinator:v1"`);
      L.push(`    promptTemplate: |-`);
      for (const line of s.prompt.split("\n")) L.push(`      ${line.trim()}`);
      if (s.tools && s.tools.length) {
        L.push(`    tools: [${s.tools.map((t) => `"${t}"`).join(", ")}]`);
      }
    }
  }
  return L.join("\n") + "\n";
}

// ---- Orchestration ---------------------------------------------------------

export interface SessionLearnResult {
  action: "save" | "update";
  trigger: string;
  steps: number;
  path: string;
}

/**
 * Turn the LLM's summary text into saved/updated recipe files.
 * Returns the recipes that were written; skip/duplicate decisions are silent.
 */
export function learnFromSession(
  existing: WorkflowManifest[],
  llmText: string,
  dir?: string,
): SessionLearnResult[] {
  const candidates = parseSessionRecipes(llmText);
  if (candidates.length === 0) return [];

  const results: SessionLearnResult[] = [];
  const wfDir = join(dir || process.cwd(), ".ouroboros", "skills", "workflows");
  for (const c of candidates) {
    const plan = planSessionRecipe(c, existing);
    if (plan.action !== "save" && plan.action !== "update") continue;
    const file = join(wfDir, `${slugify(c.name)}.yaml`);
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(file, emitSessionRecipeYAML(c), "utf-8");
    results.push({ action: plan.action, trigger: plan.trigger, steps: c.steps.length, path: file });
  }
  return results;
}
