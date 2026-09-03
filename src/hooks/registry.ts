// =============================================================================
// Hook Registry — 10 anchor points for extending framework behavior (Phase 5)
// =============================================================================

export type HookAnchor =
  | "pre-tool-execute"
  | "post-tool-result"
  | "pre-permission-prompt"
  | "pre-file-write"
  | "pre-bash-execute"
  | "on-agent-spawn"
  | "on-context-assemble"
  | "on-compaction-trigger"
  | "on-result-aggregate"
  | "pre-session-resume";

export interface HookResult {
  action: "pass" | "block" | "modify";
  event?: unknown;
  reason?: string;
}

export type HookHandler = (event: unknown, context: Record<string, unknown>) => Promise<HookResult> | HookResult;

interface RegisteredHook {
  anchor: HookAnchor;
  handler: HookHandler;
  priority: number;
  source: string;
}

const SECURITY_ANCHORS: HookAnchor[] = ["pre-tool-execute", "pre-file-write", "pre-bash-execute"];

export class HookRegistry {
  private hooks = new Map<HookAnchor, RegisteredHook[]>();

  /** Register a hook handler for an anchor point */
  register(
    anchor: HookAnchor,
    handler: HookHandler,
    options?: { priority?: number; source?: string },
  ): () => void {
    const hook: RegisteredHook = {
      anchor,
      handler,
      priority: options?.priority ?? (SECURITY_ANCHORS.includes(anchor) ? 1000 : 500),
      source: options?.source ?? "unknown",
    };

    const existing = this.hooks.get(anchor) ?? [];
    existing.push(hook);
    existing.sort((a, b) => b.priority - a.priority);
    this.hooks.set(anchor, existing);

    return () => {
      const updated = (this.hooks.get(anchor) ?? []).filter((h) => h !== hook);
      this.hooks.set(anchor, updated);
    };
  }

  /** Run all hooks for an anchor point. Returns first block, or aggregate result. */
  async run(
    anchor: HookAnchor,
    event: unknown,
    context: Record<string, unknown> = {},
  ): Promise<HookResult> {
    const hooks = this.hooks.get(anchor) ?? [];
    let modifiedEvent = event;

    for (const hook of hooks) {
      try {
        const result = await hook.handler(modifiedEvent, context);
        if (result.action === "block") {
          return result;
        }
        if (result.action === "modify" && result.event) {
          modifiedEvent = result.event;
        }
      } catch (err) {
        process.stderr.write(`[Hook:${anchor}:${hook.source}] Error: ${err}\n`);
        // Continue with next hook on error
      }
    }

    return { action: "pass" };
  }

  /** List all registered hooks (for debug) */
  list(): Array<{ anchor: HookAnchor; source: string; priority: number }> {
    const result: Array<{ anchor: HookAnchor; source: string; priority: number }> = [];
    for (const [anchor, hooks] of this.hooks) {
      for (const h of hooks) {
        result.push({ anchor, source: h.source, priority: h.priority });
      }
    }
    return result;
  }
}
