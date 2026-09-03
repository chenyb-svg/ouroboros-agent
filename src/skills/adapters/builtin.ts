// =============================================================================
// BuiltinAdapter — Registers framework-native agents (coordinator, file-reader)
// These are the only agents that ship with the framework.
// =============================================================================

import type { SkillAdapter } from "../adapter.js";
import type { AgentContract } from "../../types/agents.js";

const BUILTIN_AGENTS: AgentContract[] = [
  {
    identity: {
      source: "builtin",
      name: "coordinator",
      version: "v1",
      displayName: "Coordinator",
      description:
        "Default coordinator agent. Analyzes user intent, delegates to workers, aggregates results. Has terminal write privilege.",
    },
    type: "Coordinator",
    capabilities: {
      canReadFiles: true,
      canWriteFiles: false,
      canExecuteBash: false,
      canDelegate: true,
      canModifyContext: true,
      preferredModel: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        temperature: 0.7,
        maxTokens: 8192,
      },
      providedTools: ["ouroboros:read", "ouroboros:write_shared_state", "ouroboros:spawn_worker"],
      domainTags: ["orchestration", "coordination", "intent-analysis"],
    },
    contextPolicy: {
      level: "clean",
    },
    systemPrompt: `You are the Ouroboros Coordinator. Your role is to:
1. Analyze the user's request and determine intent.
2. If the request can be answered directly, provide a concise response.
3. If the request requires tool execution, delegate to a suitable Worker agent.
4. Aggregate results from Workers and present them to the user.
5. When in doubt, ask the user for clarification rather than making assumptions.`,
  },
  {
    identity: {
      source: "builtin",
      name: "file-reader",
      version: "v1",
      displayName: "File Reader",
      description: "Reads files and returns their contents. Simple Worker agent.",
    },
    type: "Worker",
    capabilities: {
      canReadFiles: true,
      canWriteFiles: false,
      canExecuteBash: false,
      canDelegate: false,
      canModifyContext: false,
      providedTools: ["ouroboros:read"],
      domainTags: ["file-reading", "code-analysis"],
    },
    contextPolicy: {
      level: "snapshot",
      maxSnapshotMessages: 20,
    },
    systemPrompt:
      "You are a file reading worker. Read the requested files and return a summary of their contents.",
  },
];

export class BuiltinAdapter implements SkillAdapter {
  readonly name = "builtin";

  canHandle(_path: string): boolean {
    return false; // Builtin agents don't come from files
  }

  async parse(_path: string): Promise<AgentContract[]> {
    return []; // Builtin agents are hardcoded
  }

  /** Get the built-in agents directly */
  getAgents(): AgentContract[] {
    return BUILTIN_AGENTS.map((a) => ({ ...a }));
  }

  watch(
    _path: string,
    _onChange: (contracts: AgentContract[]) => void,
  ): () => void {
    return () => {}; // Builtin agents don't change at runtime
  }
}
