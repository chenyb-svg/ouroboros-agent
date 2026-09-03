// =============================================================================
// Tool Executor — Single gate for all tool calls
// Handles: validation, resolution, permission check, tracking, result truncation
// =============================================================================

import type { EventBus } from "../bus/event-bus.js";
import type { ToolFQN, ToolResult } from "../types/tools.js";
import type { BudgetTracker } from "../budget/tracker.js";
import { ToolRegistry } from "./registry.js";
import { randomUUID } from "node:crypto";

export class ToolExecutor {
  private registry: ToolRegistry;
  private bus: EventBus;
  private sessionId: string;

  constructor(registry: ToolRegistry, bus: EventBus, sessionId: string) {
    this.registry = registry;
    this.bus = bus;
    this.sessionId = sessionId;
  }

  /**
   * Execute a tool call. This is the ONLY path for tool execution.
   */
  async execute(
    fqn: ToolFQN,
    args: Record<string, unknown>,
    agentContext: {
      agentId: string;
      instanceId: string;
      emit: (type: string, payload: Record<string, unknown>) => void;
      getBudget: () => { turnsUsed: number; tokensUsed: number };
      onAbort?: (cb: () => void) => void;
      onWriteOutsideWorkspace?: (path: string) => Promise<boolean>;
    },
    budgetTracker?: BudgetTracker,
  ): Promise<ToolResult> {
    // 1. Resolve FQN
    const tool = this.registry.resolve(fqn);
    if (!tool) {
      return { success: false, output: "", error: `Unknown tool: ${fqn}` };
    }

    // 2. Validate parameters (basic check for Phase 2)
    for (const param of tool.parameters) {
      if (param.required && !(param.name in args)) {
        return {
          success: false,
          output: "",
          error: `Missing required parameter: ${param.name}`,
        };
      }
    }

    // 3. Check tool-specific budget
    if (budgetTracker) {
      const status = budgetTracker.getStatus();
      const toolCalls = status.toolCallsByType[fqn] ?? 0;
      const maxCalls = status.spec.maxToolCalls[fqn] ?? Infinity;
      if (toolCalls >= maxCalls) {
        return {
          success: false,
          output: "",
          error: `Tool budget exceeded for ${fqn}: ${toolCalls}/${maxCalls} calls`,
        };
      }

      // Check file budget
      if (fqn.includes(":write") && status.filesModified.length >= status.spec.maxFilesModified) {
        return {
          success: false,
          output: "",
          error: `File modification budget exceeded: ${status.filesModified.length}/${status.spec.maxFilesModified} files`,
        };
      }
    }

    // 4. Execute
    const result = await this.registry.execute(fqn, args, agentContext);

    // 5. Track in budget
    if (budgetTracker) {
      budgetTracker.recordToolCall(fqn);
      if (result.modifiedFiles && result.modifiedFiles.length > 0) {
        for (const f of result.modifiedFiles) {
          budgetTracker.recordFileModified(f);
        }
      }
    }

    // 6. Truncate large outputs
    const MAX_OUTPUT = 100_000; // 100KB
    if (result.output.length > MAX_OUTPUT) {
      result.output = result.output.slice(0, MAX_OUTPUT) + `\n... [truncated ${result.output.length - MAX_OUTPUT} bytes]`;
    }

    return result;
  }
}
