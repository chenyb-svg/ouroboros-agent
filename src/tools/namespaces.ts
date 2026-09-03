// =============================================================================
// Tool FQN Namespace System — Parse, build, validate FQNs
// Enforces "no bare tool names" rule at registration time.
// =============================================================================

import type { ToolFQN, ParsedFQN } from "../types/tools.js";

/**
 * Parse a ToolFQN into its parts.
 * "ouroboros:read" → { namespace: "ouroboros", toolName: "read" }
 * "mcp:github:search" → { namespace: "mcp:github", toolName: "search" }
 */
export function parseFQN(fqn: ToolFQN): ParsedFQN {
  const parts = fqn.split(":");
  if (parts.length < 2) {
    throw new Error(`Invalid ToolFQN: "${fqn}". Must be at least "namespace:name".`);
  }

  // For MCP tools, the namespace is "mcp:server" and the toolName is the rest
  if (parts[0] === "mcp" && parts.length >= 3) {
    return {
      namespace: `${parts[0]}:${parts[1]}`,
      toolName: parts.slice(2).join(":"),
    };
  }

  return {
    namespace: parts[0],
    toolName: parts.slice(1).join(":"),
  };
}

/**
 * Build a ToolFQN from namespace and tool name.
 */
export function buildFQN(namespace: string, toolName: string): ToolFQN {
  return `${namespace}:${toolName}`;
}

/**
 * Validate a ToolFQN.
 */
export function validateFQN(fqn: string): boolean {
  if (typeof fqn !== "string" || fqn.length === 0) return false;
  const parts = fqn.split(":");
  if (parts.length < 2) return false;
  // Each part must be non-empty
  return parts.every((p) => p.length > 0);
}

/**
 * Known namespaces
 */
export const KNOWN_NAMESPACES = [
  "ouroboros",
  "claude-code",
  "mcp",
  "openclaw",
  "dynamic",
] as const;

/**
 * Check if an FQN belongs to a known namespace.
 */
export function isKnownNamespace(fqn: ToolFQN): boolean {
  try {
    const parsed = parseFQN(fqn);
    return KNOWN_NAMESPACES.some((ns) => parsed.namespace.startsWith(ns));
  } catch {
    return false;
  }
}
