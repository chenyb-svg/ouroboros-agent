// =============================================================================
// Agent Contract Validator — Static validation of AgentContract
// Framework rejects agents without valid contracts before loading.
// =============================================================================

import type { AgentContract, AgentType, AgentCapabilities } from "../types/agents.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate an AgentContract. Returns structured errors/warnings.
 * Called by SkillAdapter.parse() and SkillRegistry.loadAll().
 */
export function validateContract(contract: AgentContract): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ---- Required identity fields ----
  if (!contract.identity) {
    return { valid: false, errors: ["Missing identity"], warnings: [] };
  }
  const id = contract.identity;
  if (!id.source) errors.push(`Agent "${id.displayName || "?"}": missing identity.source`);
  if (!id.name) errors.push(`Agent "${id.source || "?"}": missing identity.name`);
  if (!id.version) errors.push(`Agent "${id.source}:${id.name}": missing identity.version`);
  if (!id.displayName) errors.push(`Agent "${id.source}:${id.name}": missing displayName`);

  // ---- Required type ----
  const validTypes: AgentType[] = ["Coordinator", "Worker", "Specialist", "ToolAgent"];
  if (!validTypes.includes(contract.type)) {
    errors.push(`Agent "${id.source}:${id.name}": invalid type "${contract.type}"`);
  }

  // ---- Required capabilities ----
  if (!contract.capabilities) {
    errors.push(`Agent "${id.source}:${id.name}": missing capabilities`);
    return { valid: false, errors, warnings };
  }

  const caps = contract.capabilities;

  // ---- Capability consistency rules ----
  switch (contract.type) {
    case "Coordinator":
      if (caps.canDelegate === false) {
        warnings.push("Coordinator should have canDelegate=true");
      }
      break;

    case "Worker":
      // Workers must not have terminal write — enforced at runtime, not contract
      break;

    case "Specialist":
      // Specialist can have canDelegate but it's optional
      break;

    case "ToolAgent":
      if (caps.canDelegate) {
        errors.push("ToolAgent cannot have canDelegate=true");
      }
      if (caps.canModifyContext) {
        errors.push("ToolAgent cannot have canModifyContext=true");
      }
      // ToolAgent must provide at least one tool
      if (!caps.providedTools || caps.providedTools.length === 0) {
        errors.push("ToolAgent must provide at least one tool");
      }
      break;
  }

  // ---- Context policy ----
  if (!contract.contextPolicy) {
    warnings.push(`Agent "${id.source}:${id.name}": no contextPolicy, defaulting to "snapshot"`);
  }

  // ---- System prompt ----
  if (!contract.systemPrompt || contract.systemPrompt.trim().length === 0) {
    warnings.push(`Agent "${id.source}:${id.name}": empty systemPrompt`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Check whether a delegation's authorized tools are within the worker's capabilities.
 */
export function validateDelegationTools(
  authorizedTools: string[],
  workerCaps: AgentCapabilities,
): { valid: boolean; disallowed: string[] } {
  // If worker canExecuteBash and the authorized tools include bash FQNs, allow
  // For Phase 2 (mock), just check basic consistency
  const disallowed: string[] = [];

  for (const tool of authorizedTools) {
    if (tool.includes(":bash") && !workerCaps.canExecuteBash) {
      disallowed.push(tool);
    }
    if (tool.includes(":write") && !workerCaps.canWriteFiles) {
      disallowed.push(tool);
    }
  }

  return { valid: disallowed.length === 0, disallowed };
}
