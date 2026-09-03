// =============================================================================
// Plugin Loader — Loads plugins with vm.Script isolation (Phase 5)
// =============================================================================

import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import type { HookRegistry, HookResult } from "./registry.js";

export interface PluginManifest {
  name: string;
  version: string;
  hooks: Array<{
    anchor: string;
    handler: string; // function body as string (for vm isolation)
  }>;
}

export class PluginLoader {
  private registry: HookRegistry;

  constructor(registry: HookRegistry) {
    this.registry = registry;
  }

  /** Load a plugin from a file path */
  loadPlugin(path: string): boolean {
    try {
      const raw = readFileSync(path, "utf-8");

      // Parse the plugin as JSON manifest
      const manifest: PluginManifest = JSON.parse(raw);

      if (!manifest.name || !manifest.hooks) {
        process.stderr.write(`[PluginLoader] Invalid plugin manifest: ${path}\n`);
        return false;
      }

      for (const hookDef of manifest.hooks) {
        if (!hookDef.anchor || !hookDef.handler) continue;

        // Create an isolated VM context for the handler
        const sandbox: {
          console: { log: () => void; error: () => void };
          result: HookResult | null;
          event: unknown;
          context: unknown;
        } = {
          console: { log: () => {}, error: () => {} },
          result: null,
          event: null,
          context: null,
        };

        const context = createContext(sandbox);
        const script = new Script(`
          result = (function(event, context) {
            ${hookDef.handler}
          })(event, context);
        `);

        // Register the hook with the VM-wrapped handler
        this.registry.register(
          hookDef.anchor as any,
          async (event, ctx) => {
            sandbox.event = event as unknown;
            sandbox.context = ctx as unknown;
            script.runInContext(context);
            return sandbox.result ?? { action: "pass" };
          },
          { source: manifest.name },
        );
      }

      return true;
    } catch (err) {
      process.stderr.write(`[PluginLoader] Failed to load ${path}: ${err}\n`);
      return false;
    }
  }

  /** Load multiple plugins from config paths */
  loadAll(paths: string[]): number {
    let loaded = 0;
    for (const path of paths) {
      if (this.loadPlugin(path)) loaded++;
    }
    return loaded;
  }
}
