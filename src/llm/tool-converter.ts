// =============================================================================
// Tool Converter — ToolDefinition[] → OpenAI tool schemas
// Handles FQN sanitization (colons → underscores) for API compatibility.
// =============================================================================

import type { ToolDefinition } from "../types/tools.js";
import type { LlmTool } from "./types.js";

/**
 * Sanitize an FQN for the LLM API.
 * OpenAI/DeepSeek only allows [a-zA-Z0-9_-] in function names.
 * We replace colons with underscores and maintain a reverse mapping.
 */
export function sanitizeToolName(fqn: string): string {
  return fqn.replace(/:/g, "_");
}

/**
 * Reverse the sanitization to get back the original FQN.
 */
const fqnReverseMap = new Map<string, string>();

export function desanitizeToolName(sanitized: string): string {
  return fqnReverseMap.get(sanitized) ?? sanitized;
}

/**
 * Convert ToolDefinition[] to OpenAI-compatible LlmTool[].
 * Sanitizes FQN names and builds a reverse mapping.
 */
export function convertTools(tools: ToolDefinition[]): LlmTool[] {
  fqnReverseMap.clear();

  return tools.map((tool) => {
    const sanitized = sanitizeToolName(tool.fqn);
    fqnReverseMap.set(sanitized, tool.fqn);

    return {
      name: sanitized,
      description: buildToolDescription(tool),
      parameters: buildJsonSchema(tool),
    };
  });
}

/**
 * Build a rich description that guides the LLM.
 */
function buildToolDescription(tool: ToolDefinition): string {
  let desc = tool.description;
  desc += `\n\nFQN: ${tool.fqn}`;
  if (tool.dangerous) {
    desc += `\n\nWARNING: This tool requires user permission before execution.`;
  }
  return desc;
}

/**
 * Build JSON Schema from ToolDefinition parameters.
 */
function buildJsonSchema(tool: ToolDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const p of tool.parameters) {
    properties[p.name] = {
      type: toolParamToJsonType(p.type),
      description: p.description,
    };
    if (p.required) required.push(p.name);
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function toolParamToJsonType(type: string): string {
  const map: Record<string, string> = {
    string: "string",
    number: "number",
    boolean: "boolean",
    object: "object",
    array: "array",
  };
  return map[type] ?? "string";
}
