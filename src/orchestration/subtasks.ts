// =============================================================================
// Subtask Registry (P1-B) — background workers + ticket polling
// The coordinator delegates independent subtasks to isolated workers that run
// a small self-contained ReAct loop with their own LLM context. Returns a
// ticket; the coordinator polls for the result without blocking its own loop.
// =============================================================================

import { randomUUID } from "node:crypto";

export interface SubtaskState {
  ticketId: string;
  task: string;
  status: "running" | "completed" | "failed";
  result?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  tokensUsed: number;
}

export interface WorkerMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  toolCallId?: string;
}

export interface SubtaskRegistryDeps {
  /** Lazy provider accessor — repl.ts holds the module-level provider. */
  provider: () => {
    call: (opts: {
      messages: WorkerMessage[];
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
      tools?: any[];
      toolChoice?: string;
      signal?: AbortSignal;
    }) => AsyncIterable<any>;
  };
  /** OpenAI-shaped tool list the worker may use (default: read-only tools). */
  buildWorkerTools: () => any[];
  /** Execute a tool for the worker. Returns a ToolResult-like object. */
  executeTool: (fqn: string, args: any) => Promise<{ success: boolean; output: string; error?: string }>;
  systemPromptFor: (task: string) => string;
  timeoutMs?: number;
  maxTurns?: number;
  maxTokens?: number;
}

export class SubtaskRegistry {
  private states = new Map<string, SubtaskState>();
  private deps: SubtaskRegistryDeps;

  constructor(deps: SubtaskRegistryDeps) {
    this.deps = deps;
  }

  /** Start a background worker. Returns immediately with a ticket ID. */
  spawn(task: string, extraTools?: string[]): string {
    const ticketId = `t-${randomUUID().slice(0, 8)}`;
    const state: SubtaskState = {
      ticketId,
      task,
      status: "running",
      startedAt: Date.now(),
      tokensUsed: 0,
    };
    this.states.set(ticketId, state);
    void this.runWorker(ticketId, state, extraTools ?? []).catch((e) => {
      state.status = "failed";
      state.error = e?.message ? String(e.message) : String(e);
      state.completedAt = Date.now();
    });
    return ticketId;
  }

  poll(ticketId: string): SubtaskState | null {
    return this.states.get(ticketId) ?? null;
  }

  listRunning(): SubtaskState[] {
    return [...this.states.values()].filter((s) => s.status === "running");
  }

  /** Every subtask in this session (running, completed, failed) — oldest first. */
  listAll(): SubtaskState[] {
    return [...this.states.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  private async runWorker(ticketId: string, state: SubtaskState, extraTools: string[]): Promise<void> {
    const provider = this.deps.provider();
    const ac = new AbortController();
    const timeoutMs = this.deps.timeoutMs ?? 120_000;
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const maxTurns = this.deps.maxTurns ?? 6;

    const tools = this.deps.buildWorkerTools();
    for (const fqn of extraTools) {
      if (fqn && !tools.some((t) => t.name === fqn.replace(/:/g, "_"))) {
        // extra tool shapes come from the same builder — look them up below via executeTool
        const extra = this.deps.buildWorkerTools().find((t) => t.name === fqn.replace(/:/g, "_"));
        if (extra) tools.push(extra);
      }
    }

    const messages: WorkerMessage[] = [{ role: "system", content: this.deps.systemPromptFor(state.task) }];

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if (ac.signal.aborted) {
          state.status = "failed";
          state.error = `Subtask timed out after ${timeoutMs / 1000}s`;
          return;
        }
        let text = "";
        const toolCalls: Array<{ id: string; name: string; args: any }> = [];
        try {
          const stream = provider.call({
            messages,
            tools,
            temperature: 0.2,
            maxTokens: this.deps.maxTokens ?? 2000,
            toolChoice: "auto",
            signal: ac.signal,
          });
          for await (const c of stream) {
            if (c.type === "text_delta") text += (c.delta ?? "");
            if (c.type === "tool_use_stop" && c.parsedArgs) {
              toolCalls.push({
                id: c.id,
                name: ((c.name ?? "") as string).replace(/_/g, ":"),
                args: c.parsedArgs,
              });
            }
            if (c.type === "usage") state.tokensUsed += (c.totalTokens ?? 0);
          }
        } catch (e: any) {
          if (e?.name === "AbortError") {
            state.status = "failed";
            state.error = `Subtask timed out after ${timeoutMs / 1000}s`;
            return;
          }
          state.status = "failed";
          state.error = e?.message ? String(e.message) : String(e);
          return;
        }

        if (toolCalls.length === 0) {
          state.status = "completed";
          state.result = text.trim() || "(empty response)";
          return;
        }

        messages.push({
          role: "assistant",
          content: text || "",
          toolCalls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name.replace(/:/g, "_"), arguments: JSON.stringify(tc.args) },
          })),
        });

        for (const tc of toolCalls) {
          let r: { success: boolean; output: string; error?: string };
          try {
            r = await this.deps.executeTool(tc.name, tc.args);
          } catch (e: any) {
            r = { success: false, output: "", error: e?.message ? String(e.message) : String(e) };
          }
          const content = r.success
            ? (r.output || "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").slice(0, 8000)
            : `${r.error || "error"}\n${(r.output || "").slice(0, 4000)}`;
          messages.push({ role: "tool", content, toolCallId: tc.id });
        }
      }

      if (state.status === "running") {
        state.status = "completed";
        state.result = "(worker reached its turn budget without a final answer)";
      }
    } finally {
      clearTimeout(timer);
      state.completedAt = Date.now();
    }
  }
}
