// =============================================================================
// Tool Registry — FQN-enforced tool registration, resolution, visibility
// =============================================================================

import type { ToolFQN, ToolDefinition, ToolVisibilityMatrix, ToolOverride, ToolResult } from "../types/tools.js";
import type { AgentContract } from "../types/agents.js";
import { validateFQN } from "./namespaces.js";

export class ToolRegistry {
  private tools = new Map<ToolFQN, ToolDefinition>();
  private overrides = new Map<ToolFQN, ToolFQN>();

  /**
   * Register a tool. Rejects if FQN is invalid (no bare names allowed).
   */
  register(tool: ToolDefinition): boolean {
    if (!validateFQN(tool.fqn)) {
      return false;
    }
    this.tools.set(tool.fqn, tool);
    return true;
  }

  /**
   * Register multiple tools at once.
   */
  registerAll(tools: ToolDefinition[]): { success: number; failed: number } {
    let success = 0;
    let failed = 0;
    for (const tool of tools) {
      if (this.register(tool)) success++;
      else failed++;
    }
    return { success, failed };
  }

  /**
   * Resolve an FQN to its tool definition.
   * Follows the override chain.
   */
  resolve(fqn: ToolFQN): ToolDefinition | undefined {
    // Check overrides first
    const override = this.overrides.get(fqn);
    if (override) {
      return this.tools.get(override);
    }
    return this.tools.get(fqn);
  }

  /**
   * Set up a tool override (e.g., replace builtin read with claude-code read).
   */
  setOverride(original: ToolFQN, replacement: ToolFQN): void {
    this.overrides.set(original, replacement);
  }

  /**
   * Build the tool visibility matrix for a specific agent.
   * Based on agent capabilities and type.
   */
  buildVisibilityMatrix(contract: AgentContract): ToolVisibilityMatrix {
    const visibleTools: ToolFQN[] = [];
    const blockedTools: ToolFQN[] = [];

    for (const [fqn, tool] of this.tools) {
      let visible = false;

      switch (tool.defaultVisibility) {
        case "all":
          visible = true;
          break;
        case "Coordinator":
          visible = contract.type === "Coordinator";
          break;
        case "Worker":
          visible = contract.type === "Worker" || contract.type === "Specialist";
          break;
        case "Specialist":
          visible = contract.type === "Specialist";
          break;
        case "ToolAgent":
          visible = contract.type === "ToolAgent";
          break;
        case "none":
          visible = false;
          break;
      }

      // Block dangerous tools based on capabilities
      if (visible && tool.dangerous) {
        if (
          (fqn.includes(":bash") && !contract.capabilities.canExecuteBash) ||
          (fqn.includes(":write") && !contract.capabilities.canWriteFiles)
        ) {
          visible = false;
          blockedTools.push(fqn);
        }
      }

      if (visible) {
        visibleTools.push(fqn);
      }
    }

    // Add agent's own provided tools
    for (const provided of contract.capabilities.providedTools) {
      if (!visibleTools.includes(provided) && this.tools.has(provided)) {
        visibleTools.push(provided);
      }
    }

    return {
      agentId: `${contract.identity.source}:${contract.identity.name}:${contract.identity.version}`,
      visibleTools,
      blockedTools,
    };
  }

  /**
   * Execute a tool by FQN.
   */
  async execute(
    fqn: ToolFQN,
    args: Record<string, unknown>,
    agentContext: unknown,
  ): Promise<ToolResult> {
    const tool = this.resolve(fqn);
    if (!tool) {
      return {
        success: false,
        output: "",
        error: `Tool not found: ${fqn}`,
      };
    }

    try {
      return await tool.execute(args, agentContext);
    } catch (err) {
      return {
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * List all registered tools.
   */
  listAll(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * List tools by namespace.
   */
  listByNamespace(namespace: string): ToolDefinition[] {
    return [...this.tools.values()].filter((t) =>
      t.fqn.startsWith(`${namespace}:`),
    );
  }
}
