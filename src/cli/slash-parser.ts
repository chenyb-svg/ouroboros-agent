// =============================================================================
// Slash Parser — /command parsing, validation, help, Tab completion (Phase 6+)
// =============================================================================

import type { WorkflowDefinition, WorkflowManifest } from "../types/workflow.js";
import type { WorkflowRegistry } from "../workflows/registry.js";

export interface ParsedSlashCommand {
  command: string;
  args: string[];         // positional args
  flags: Record<string, string | boolean>;  // --flag value or --bool-flag
  raw: string;
}

export class SlashParser {
  private registry: WorkflowRegistry;

  constructor(registry: WorkflowRegistry) {
    this.registry = registry;
  }

  /** Parse a slash command input string */
  parse(input: string): ParsedSlashCommand | null {
    if (!input.startsWith("/")) return null;

    const trimmed = input.trim();
    const parts = trimmed.split(/\s+/);
    const command = parts[0]; // e.g., "/review"

    const args: string[] = [];
    const flags: Record<string, string | boolean> = {};

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      if (part.startsWith("--")) {
        const key = part.slice(2);
        // Check if next part is a value or another flag
        const next = parts[i + 1];
        if (next && !next.startsWith("--") && !next.startsWith("-")) {
          flags[key] = next;
          i++; // consume value
        } else {
          flags[key] = true; // boolean flag
        }
      } else if (part.startsWith("-") && part.length === 2) {
        const key = part.slice(1);
        const next = parts[i + 1];
        if (next && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      } else {
        args.push(part);
      }
    }

    return { command, args, flags, raw: trimmed };
  }

  /** Validate parsed input against workflow inputSchema */
  validate(
    parsed: ParsedSlashCommand,
    workflow: WorkflowDefinition,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const schema = workflow.inputSchema;
    if (!schema) return { valid: true, errors: [] };

    // Check required parameters (from flags OR positional args)
    for (const [name, param] of Object.entries(schema.parameters)) {
      const fromFlag = parsed.flags[name];
      const fromShort = schema.flags?.[name]?.short ? parsed.flags[schema.flags[name].short!] : undefined;
      const fromArgs = parsed.args[Object.keys(schema.parameters).indexOf(name)];
      const value = fromFlag ?? fromShort ?? fromArgs;
      if (param.required && !value) {
        errors.push(`Missing required parameter: ${name} (use --${name} <value>)`);
      }
    }

    // Check required flags
    for (const [name, flag] of Object.entries(schema.flags)) {
      const value = parsed.flags[name] ?? parsed.flags[flag.short ?? ""];
      if (flag.required && value === undefined) {
        errors.push(`Missing required flag: --${name}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /** Render help text for a workflow by ID or trigger (zero LLM calls) */
  renderHelp(lookup: string): string {
    // Try exact ID first, then trigger match (strip leading /)
    const wf = this.registry.get(lookup)
      ?? this.registry.getByTrigger(lookup.startsWith("/") ? lookup : `/${lookup}`);
    if (!wf) return `Workflow not found: ${lookup}`;

    const def = wf.definition;
    const lines: string[] = [
      `## ${def.name} (${def.trigger})`,
      `${def.description}`,
      `Version: ${def.version} | Type: ${def.type}`,
      "",
    ];

    // Parameters
    if (def.inputSchema?.parameters) {
      lines.push("### Parameters");
      for (const [name, param] of Object.entries(def.inputSchema.parameters)) {
        const req = param.required ? " (required)" : " (optional)";
        lines.push(`  ${name}: ${param.description}${req}`);
      }
      lines.push("");
    }

    // Flags
    if (def.inputSchema?.flags) {
      lines.push("### Flags");
      for (const [name, flag] of Object.entries(def.inputSchema.flags)) {
        const short = flag.short ? `-${flag.short}, ` : "";
        const req = flag.required ? " [required]" : "";
        lines.push(`  ${short}--${name}: ${flag.description}${req}`);
      }
      lines.push("");
    }

    // Steps
    lines.push(`### Steps (${def.steps.length})`);
    for (let i = 0; i < def.steps.length; i++) {
      const step = def.steps[i];
      lines.push(`  ${i + 1}. **${step.name}** → \`${step.agent}\``);
    }
    lines.push("");

    // Examples
    lines.push("### Example");
    const exampleFlags = Object.entries(def.inputSchema?.flags ?? {})
      .map(([name, flag]) => `--${name} <value>`)
      .join(" ");
    lines.push(`  ${def.trigger} ${exampleFlags}`);

    return lines.join("\n");
  }

  /** Render list of all workflows for /help */
  renderAllHelp(): string {
    const all = this.registry.listAll();
    if (all.length === 0) return "No workflows loaded.";

    const lines = ["## Available Commands", ""];
    for (const wf of all) {
      lines.push(`  ${wf.definition.trigger.padEnd(18)} ${wf.definition.description}`);
    }
    lines.push("");
    lines.push("Type /help <command> for details.");
    return lines.join("\n");
  }

  /** Get Tab completion candidates (pure memory cache, <50ms) */
  getCompletions(prefix: string): string[] {
    return this.registry.getCompletions(prefix);
  }
}
