// =============================================================================
// Recipe Save — turn a session trace into an editable WorkflowDefinition YAML
// =============================================================================

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export function slugify(s: string): string {
  // CJK-aware: keep Chinese chars so task names get real ids/triggers
  // (previously all-Chinese names collapsed to "recipe").
  return (s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "") || "recipe").slice(0, 40);
}

function esc(s: string): string {
  return s.replace(/"/g, "'").replace(/\\/g, "\\\\");
}

/**
 * Normalize a tool-call name from a session trace. The repl stores the wire
 * form ("ouroboros_read") in conversation history, while YAML recipes use the
 * FQN form ("ouroboros:read"). Accept both.
 */
export function normalizeToolFqn(raw: string): string {
  const s = String(raw ?? "");
  return s.startsWith("ouroboros_") ? s.replace(/_/g, ":") : s;
}

/**
 * Heuristic: cluster conversation history into steps.
 * Each user input opens a step; the assistant tool calls that follow define its tools.
 */
export function generateDraftFromTrace(
  conversationHistory: any[],
  _userInputs: string[],
  name: string,
  description: string,
): string {
  const steps: Array<{ prompt: string; tools: string[] }> = [];
  let current: { prompt: string; tools: string[] } | null = null;

  for (const m of conversationHistory) {
    if (m?.role === "user") {
      if (current) steps.push(current);
      const content = String(m.content ?? "").trim().slice(0, 400);
      current = { prompt: content || "(user request)", tools: [] };
    } else if (current && m?.role === "assistant" && Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        const fqn = normalizeToolFqn(tc?.function?.name || tc?.name);
        if (fqn.startsWith("ouroboros:") && !current.tools.includes(fqn)) {
          current.tools.push(fqn);
        }
      }
    }
  }
  if (current) steps.push(current);

  const realSteps = steps.filter((s) => s.prompt && s.prompt !== "(user request)").slice(0, 6);
  const id = slugify(name);

  const L: string[] = [];
  L.push(`# Recipe draft generated from a session trace`);
  L.push(`id: ${id}`);
  L.push(`name: "${esc(name)}"`);
  L.push(`description: "${esc(description || "Reusable workflow")}"`);
  L.push(`trigger: "/${id}"`);
  L.push(`version: "0.1.0"`);
  L.push(`type: sequential`);
  L.push(`steps:`);

  if (realSteps.length === 0) {
    L.push(`  - id: step1`);
    L.push(`    name: "Default step"`);
    L.push(`    agent: "builtin:coordinator:v1"`);
    L.push(`    promptTemplate: |-`);
    L.push(`      Complete the requested task and report the result.`);
  } else {
    for (const [i, s] of realSteps.entries()) {
      const title = (s.prompt.split("\n")[0] || `Step ${i + 1}`).slice(0, 48);
      L.push(`  - id: step${i + 1}`);
      L.push(`    name: "${esc(title)}"`);
      L.push(`    agent: "builtin:coordinator:v1"`);
      L.push(`    promptTemplate: |-`);
      for (const line of s.prompt.split("\n")) L.push(`      ${line.trim()}`);
      if (s.tools.length > 0) {
        L.push(`    tools: [${s.tools.map((t) => `"${t}"`).join(", ")}]`);
      }
    }
  }
  return L.join("\n") + "\n";
}

/** Write a draft recipe from the current session trace; returns the saved path. */
export function saveRecipeFromTrace(
  conversationHistory: any[],
  userInputs: string[],
  name: string,
  description: string,
  dir?: string,
): string {
  const wfDir = join(dir || process.cwd(), ".ouroboros", "skills", "workflows");
  mkdirSync(wfDir, { recursive: true });
  const file = join(wfDir, `${slugify(name)}.yaml`);
  const draft = generateDraftFromTrace(conversationHistory, userInputs, name, description);
  writeFileSync(file, draft, "utf-8");
  return file;
}

/**
 * Generate a recipe draft from a single turn's execution trace.
 * Unlike generateDraftFromTrace (which clusters by user message and collapses a
 * single turn into one step), this splits by *assistant tool rounds* — each
 * assistant message that used tools becomes one step, so a real multi-step
 * workflow emerges from one complex turn.
 */
export function generateDraftFromExecution(
  turnMessages: any[],
  name: string,
  description: string,
): string {
  const steps: Array<{ prompt: string; tools: string[] }> = [];
  for (const m of turnMessages) {
    if (m?.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      const tools: string[] = [];
      for (const tc of m.toolCalls) {
        const fqn = normalizeToolFqn(tc?.function?.name || tc?.name);
        if (fqn.startsWith("ouroboros:") && !tools.includes(fqn)) tools.push(fqn);
      }
      const prompt = String(m.content ?? "").trim().slice(0, 400);
      steps.push({
        prompt: prompt || (tools.length > 0 ? `(use tools: ${tools.join(", ")})` : "Continue the task"),
        tools,
      });
    }
  }

  const realSteps = steps.slice(0, 6);
  const id = slugify(name);

  const L: string[] = [];
  L.push(`# auto-learned by ouroboros`);
  L.push(`id: ${id}`);
  L.push(`name: "${esc(name)}"`);
  L.push(`description: "${esc(description || "Reusable workflow")}"`);
  L.push(`trigger: "/${id}"`);
  L.push(`version: "0.1.0"`);
  L.push(`type: sequential`);
  L.push(`steps:`);

  if (realSteps.length === 0) {
    L.push(`  - id: step1`);
    L.push(`    name: "${esc((name || "Default step").slice(0, 48))}"`);
    L.push(`    agent: "builtin:coordinator:v1"`);
    L.push(`    promptTemplate: |-`);
    L.push(`      Complete the requested task and report the result.`);
  } else {
    for (const [i, s] of realSteps.entries()) {
      const title = (s.prompt.split("\n")[0] || `Step ${i + 1}`).slice(0, 48);
      L.push(`  - id: step${i + 1}`);
      L.push(`    name: "${esc(title)}"`);
      L.push(`    agent: "builtin:coordinator:v1"`);
      L.push(`    promptTemplate: |-`);
      for (const line of s.prompt.split("\n")) L.push(`      ${line.trim()}`);
      if (s.tools.length > 0) {
        L.push(`    tools: [${s.tools.map((t) => `"${t}"`).join(", ")}]`);
      }
    }
  }
  return L.join("\n") + "\n";
}

/** Write an auto-learned recipe from a single turn's execution; returns the saved path. */
export function saveExecutionRecipe(
  turnMessages: any[],
  name: string,
  description: string,
  dir?: string,
): string {
  const wfDir = join(dir || process.cwd(), ".ouroboros", "skills", "workflows");
  mkdirSync(wfDir, { recursive: true });
  const file = join(wfDir, `${slugify(name)}.yaml`);
  const draft = generateDraftFromExecution(turnMessages, name, description);
  writeFileSync(file, draft, "utf-8");
  return file;
}

/**
 * Persist a user-authored workflow (built in the desktop 技能市场 → 工作流·配方)
 * as a project workflow YAML in the same shape as the trace-based savers.
 * Never overwrites an existing file (a same-slug name is a real collision with
 * a hand-written or auto-learned recipe) → returns {ok, path?, error?}.
 */
export function saveUserWorkflow(opts: {
  name: string;
  description?: string;
  steps: Array<{ prompt: string; tools?: string[] }>;
  dir?: string;
}): { ok: boolean; path?: string; error?: string } {
  const name = String(opts.name ?? "").trim();
  const steps = (opts.steps ?? [])
    .filter((s) => s && String(s.prompt ?? "").trim())
    .slice(0, 6);
  if (!name) return { ok: false, error: "workflow name is required" };
  if (steps.length === 0) return { ok: false, error: "at least one step with a prompt is required" };

  const id = slugify(name);
  const wfDir = join(opts.dir || process.cwd(), ".ouroboros", "skills", "workflows");
  const file = join(wfDir, `${id}.yaml`);
  try {
    if (existsSync(file)) return { ok: false, error: `A workflow named "${name}" already exists — pick another name` };
    mkdirSync(wfDir, { recursive: true });
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }

  const L: string[] = [];
  L.push(`# user-authored workflow (created in the desktop 技能市场)`);
  L.push(`id: ${id}`);
  L.push(`name: "${esc(name)}"`);
  L.push(`description: "${esc(opts.description || "User-created workflow")}"`);
  L.push(`trigger: "/${id}"`);
  L.push(`version: "0.1.0"`);
  L.push(`type: sequential`);
  L.push(`steps:`);
  for (const [i, s] of steps.entries()) {
    const prompt = String(s.prompt).trim();
    const title = (prompt.split("\n")[0] || `Step ${i + 1}`).slice(0, 48);
    L.push(`  - id: step${i + 1}`);
    L.push(`    name: "${esc(title)}"`);
    L.push(`    agent: "builtin:coordinator:v1"`);
    L.push(`    promptTemplate: |-`);
    for (const line of prompt.split("\n")) L.push(`      ${line.trim()}`);
    const tools = (Array.isArray(s.tools) ? s.tools : [])
      .map((x) => normalizeToolFqn(String(x ?? "").trim()))
      .filter((t) => t.startsWith("ouroboros:"));
    if (tools.length > 0) L.push(`    tools: [${tools.map((t) => `"${t}"`).join(", ")}]`);
  }

  try {
    writeFileSync(file, L.join("\n") + "\n", "utf-8");
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
  return { ok: true, path: file };
}

/** Write a commented recipe template; returns the saved path (never overwrites). */
export function writeRecipeTemplate(): string {
  const dir = join(process.cwd(), ".ouroboros", "skills", "workflows");
  mkdirSync(dir, { recursive: true });
  let file = join(dir, "my-recipe.yaml");
  let i = 2;
  while (existsSync(file)) {
    file = join(dir, `my-recipe-${i}.yaml`);
    i++;
  }

  const template = `# Ouroboros Recipe template
# A recipe is a reusable multi-step workflow. Trigger it with /<trigger>, or let
# the agent auto-run it via ouroboros_run_recipe when the task matches.
id: my-recipe
name: My Recipe
description: Describe when this recipe should be used.
trigger: /my-recipe
version: "0.1.0"
type: sequential          # sequential | parallel | interactive

# Optional input documentation (used by the slash parser + interpolation)
# inputSchema:
#   parameters:
#     target:
#       type: string
#       required: true
#       description: What to work on
#   flags:
#     verbose:
#       type: boolean
#       description: Print extra detail

steps:
  - id: step1
    name: Analyze
    agent: "builtin:coordinator:v1"
    promptTemplate: |-
      Analyze the following and report concise findings:
      {{input.target}}
    tools: ["ouroboros:read", "ouroboros:search"]
    outputKey: analysis

  - id: step2
    name: Summarize
    agent: "builtin:coordinator:v1"
    promptTemplate: |-
      Based on this analysis, write a short summary:
      {{steps[0].output.summary}}
    onError:
      action: retry
      maxRetries: 2
`;
  writeFileSync(file, template, "utf-8");
  return file;
}
