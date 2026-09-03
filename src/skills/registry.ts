// =============================================================================
// Skill Registry — Discovery, loading, conflict resolution, hot-reload
// =============================================================================

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dataPath } from "../data-home.js";
import type { EventBus } from "../bus/event-bus.js";
import type { OuroborosConfig } from "../types/config.js";
import type { AgentContract } from "../types/agents.js";
import type { SkillManifest, SkillImport, SkillSource } from "../types/skills.js";
import type { SkillAdapter } from "./adapter.js";
import { BuiltinAdapter } from "./adapters/builtin.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { OpenClawAdapter } from "./adapters/openclaw.js";
import { McpAdapter } from "./adapters/mcp.js";
import { validateContract } from "../agents/contract.js";

export class SkillRegistry {
  private adapters: SkillAdapter[] = [];
  private manifests = new Map<string, SkillManifest>(); // key = agentId string
  private bus: EventBus;
  private sessionId: string;
  private builtinAdapter: BuiltinAdapter;
  private mcpAdapter: McpAdapter;

  constructor(bus: EventBus, sessionId: string) {
    this.bus = bus;
    this.sessionId = sessionId;
    this.builtinAdapter = new BuiltinAdapter();
    this.mcpAdapter = new McpAdapter();

    // Register adapters
    this.adapters = [
      this.builtinAdapter as unknown as SkillAdapter,
      new ClaudeCodeAdapter(),
      new OpenClawAdapter(),
      this.mcpAdapter,
    ];
  }

  /**
   * Discover and load all skills from configured sources.
   * Order: builtin → user skills → project skills → skill_imports
   */
  async discover(config: OuroborosConfig, projectDir: string): Promise<void> {
    // 0. Feed MCP server configs to the McpAdapter so it can produce contracts
    const mcpServers = (config as any).mcpServers || [];
    if (mcpServers.length > 0) this.mcpAdapter.setServerConfigs(mcpServers);

    // 1. Built-in skills
    const builtinAgents = this.builtinAdapter.getAgents();
    for (const contract of builtinAgents) {
      this.addManifest(
        contract,
        "builtin",
        "builtin",
        [],
      );
    }

    // 2. User-level skills (~/.ouroboros/skills/)
    const userSkillsDir = dataPath("skills");
    if (existsSync(userSkillsDir)) {
      await this.scanDirectory(userSkillsDir, "user");
    }

    // 3. Project-level skills (./.ouroboros/skills/)
    const projectSkillsDir = join(projectDir, ".ouroboros", "skills");
    if (existsSync(projectSkillsDir)) {
      await this.scanDirectory(projectSkillsDir, "project");
    }

    // 4. Explicit skill_imports from config
    for (const imp of config.skillImports) {
      await this.scanImport(imp);
    }
  }

  /**
   * Scan a directory for skills using all registered adapters.
   */
  private async scanDirectory(
    dir: string,
    source: SkillSource,
  ): Promise<void> {
    for (const adapter of this.adapters) {
      if (adapter.name === "builtin") continue; // builtin is hardcoded

      if (adapter.canHandle(dir)) {
        try {
          const contracts = await adapter.parse(dir);
          for (const contract of contracts) {
            this.addManifest(contract, adapter.name, source, []);
          }
        } catch (err) {
          this.emitLoadFailed(dir, adapter.name, err);
        }
      }
    }
  }

  /**
   * Scan an explicit skill import from config.
   */
  private async scanImport(imp: SkillImport): Promise<void> {
    if (!existsSync(imp.path)) {
      this.emitLoadFailed(
        imp.path,
        imp.adapter,
        new Error(`Path not found: ${imp.path}`),
      );
      return;
    }

    const adapter = this.adapters.find((a) => a.name === imp.adapter);
    if (!adapter) {
      this.emitLoadFailed(
        imp.path,
        imp.adapter,
        new Error(`Unknown adapter: ${imp.adapter}`),
      );
      return;
    }

    try {
      const contracts = await adapter.parse(imp.path);

      for (const contract of contracts) {
        // Apply namespace prefix if configured
        if (imp.namespace) {
          contract.identity.source = imp.namespace;
        }

        this.addManifest(contract, adapter.name, "import", []);
      }

      // Set up file watching for hot-reload
      adapter.watch(imp.path, (newContracts) => {
        for (const contract of newContracts) {
          if (imp.namespace) {
            contract.identity.source = imp.namespace;
          }
          this.reloadContract(contract, adapter.name, "import");
        }
      });
    } catch (err) {
      this.emitLoadFailed(imp.path, imp.adapter, err);
    }
  }

  /**
   * Add a manifest, handling conflict resolution.
   */
  private addManifest(
    contract: AgentContract,
    adapterName: string,
    source: SkillSource,
    warnings: string[],
  ): void {
    // Validate contract
    const validation = validateContract(contract);
    if (!validation.valid) {
      this.emitLoadFailed(
        `${contract.identity.source}:${contract.identity.name}`,
        adapterName,
        new Error(validation.errors.join("; ")),
      );
      return;
    }

    const id = `${contract.identity.source}:${contract.identity.name}:${contract.identity.version}`;
    const nameKey = `${contract.identity.source}:${contract.identity.name}`;

    // Check for conflicts with same name but different version
    const existing = this.findByName(nameKey);
    if (existing) {
      const existingId = `${existing.contract.identity.source}:${existing.contract.identity.name}:${existing.contract.identity.version}`;
      const resolved = this.resolveConflict(existing, {
        path: id,
        adapter: adapterName,
        source,
        contract,
        loadedAt: Date.now(),
        warnings: [...warnings, ...(validation.warnings ?? [])],
      });

      if (resolved === "keep-existing") return;

      if (resolved === "alias") {
        // Create aliased entry
        const aliasedName = `${contract.identity.name}-2`;
        contract.identity.name = aliasedName;
        this.bus.emit({
          eventId: randomUUID(),
          type: "SKILL_CONFLICT",
          timestamp: performance.now(),
          sessionId: this.sessionId,
          causalChainId: randomUUID(),
          payload: {
            agentName: contract.identity.name,
            existingSource: existingId,
            newSource: id,
            resolution: `aliased to ${contract.identity.source}:${aliasedName}`,
          },
        });
      }
    }

    const manifest: SkillManifest = {
      path: id,
      adapter: adapterName,
      source,
      contract: { ...contract, validationErrors: validation.errors },
      loadedAt: Date.now(),
      warnings: [...warnings, ...(validation.warnings ?? [])],
    };

    this.manifests.set(
      `${contract.identity.source}:${contract.identity.name}:${contract.identity.version}`,
      manifest,
    );
  }

  /**
   * Find a manifest by source:name (ignoring version).
   */
  private findByName(nameKey: string): SkillManifest | undefined {
    for (const manifest of this.manifests.values()) {
      const key = `${manifest.contract.identity.source}:${manifest.contract.identity.name}`;
      if (key === nameKey) return manifest;
    }
    return undefined;
  }

  /**
   * Resolve version conflict between existing and new manifest.
   */
  private resolveConflict(
    existing: SkillManifest,
    incoming: SkillManifest,
  ): "keep-existing" | "replace" | "alias" {
    // Higher priority wins
    const priorityOrder: SkillSource[] = ["project", "user", "import", "builtin"];
    const existingPrio = priorityOrder.indexOf(existing.source);
    const incomingPrio = priorityOrder.indexOf(incoming.source);

    if (incomingPrio < existingPrio) return "replace";
    if (incomingPrio > existingPrio) return "keep-existing";

    // Same priority: compare versions
    const existingVer = existing.contract.identity.version;
    const incomingVer = incoming.contract.identity.version;
    if (incomingVer > existingVer) return "replace";
    if (incomingVer < existingVer) return "keep-existing";

    // Same version, same priority: alias
    return "alias";
  }

  /**
   * Reload a single contract (for hot-reload).
   */
  private reloadContract(
    contract: AgentContract,
    adapterName: string,
    source: SkillSource,
  ): void {
    const id = `${contract.identity.source}:${contract.identity.name}:${contract.identity.version}`;

    // Update manifest but DON'T affect running instances
    const existing = this.manifests.get(id);
    if (existing) {
      existing.contract = contract;
      existing.loadedAt = Date.now();
    } else {
      this.addManifest(contract, adapterName, source, []);
    }
  }

  /**
   * Get all loaded agent contracts.
   */
  getAllContracts(): AgentContract[] {
    return [...this.manifests.values()].map((m) => m.contract);
  }

  /**
   * Get a specific contract.
   */
  getContract(agentId: string): AgentContract | undefined {
    return this.manifests.get(agentId)?.contract;
  }

  /**
   * Get all manifests (for status display).
   */
  getAllManifests(): SkillManifest[] {
    return [...this.manifests.values()];
  }

  // ---- Private ----

  private emitLoadFailed(
    path: string,
    adapter: string,
    err: unknown,
  ): void {
    const message = err instanceof Error ? err.message : String(err);
    this.bus.emit({
      eventId: randomUUID(),
      type: "SKILL_LOAD_FAILED",
      timestamp: performance.now(),
      sessionId: this.sessionId,
      causalChainId: randomUUID(),
      payload: {
        path,
        adapter,
        error: message,
      },
    });
  }
}
