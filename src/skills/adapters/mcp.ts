// =============================================================================
// McpAdapter — Dynamically discovers MCP tools via McpClient (Phase 5)
// =============================================================================

import { existsSync } from "node:fs";
import { watch } from "node:fs";
import { join, basename } from "node:path";
import type { SkillAdapter } from "../adapter.js";
import type { AgentContract } from "../../types/agents.js";
import type { McpServerConfig } from "../../types/mcp.js";

export class McpAdapter implements SkillAdapter {
  readonly name = "mcp";
  private serverConfigs: McpServerConfig[] = [];

  /** Set MCP server configs (called from bootstrap) */
  setServerConfigs(configs: McpServerConfig[]): void {
    this.serverConfigs = configs;
  }

  canHandle(path: string): boolean {
    return (
      path.includes("mcp") ||
      path.includes(".mcp") ||
      basename(path) === "mcp.json" ||
      basename(path) === "mcp.yaml"
    );
  }

  async parse(path: string): Promise<AgentContract[]> {
    const contracts: AgentContract[] = [];

    // Phase 5: Dynamic tool discovery via MCP client is handled at runtime
    // by the bootstrap (index.ts). Here we create the ToolAgent contracts
    // from the server configs.

    for (const config of this.serverConfigs) {
      contracts.push({
        identity: {
          source: "mcp",
          name: config.name,
          version: "v1",
          displayName: `MCP: ${config.name}`,
          description: `MCP server providing tools under mcp:${config.name}:* namespace`,
        },
        type: "ToolAgent",
        capabilities: {
          canReadFiles: false,
          canWriteFiles: false,
          canExecuteBash: false,
          canDelegate: false,
          canModifyContext: false,
          providedTools: [`mcp:${config.name}:*`],
          domainTags: ["mcp", config.name],
        },
        contextPolicy: {
          level: "clean",
          cleanSystemPrompt: `MCP server: ${config.name}`,
        },
        systemPrompt: `MCP Tool Agent for "${config.name}".`,
      });
    }

    return contracts;
  }

  watch(
    path: string,
    onChange: (contracts: AgentContract[]) => void,
  ): () => void {
    try {
      const watcher = watch(path, { persistent: false }, async () => {
        const contracts = await this.parse(path);
        onChange(contracts);
      });
      watcher.unref();
      return () => watcher.close();
    } catch {
      return () => {};
    }
  }
}
