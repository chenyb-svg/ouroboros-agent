// =============================================================================
// Task Tree — rebuilt from the session transcript, then overlaid with the live
// engine's in-memory state (todo list + subtask registry).
//
// Two sources feed the desktop task-tree panel:
//   1. rebuildTaskTreeFromTranscript() — replays a session's transcript.jsonl,
//      reconstructing the plan (ouroboros:plan_tasks / ouroboros:update_todo)
//      and delegated subtasks (ouroboros:delegate / ouroboros:poll) from their
//      TOOL_CALL+TOOL_RESULT pairs. Append-only, so it works for CLOSED sessions
//      read by the hidden system engine — the tree survives an app restart.
//   2. overlayLive() — a live owning engine merges its current in-memory todo
//      list + SubtaskRegistry over the rebuilt tree and marks it live:true, so
//      running subtasks appear in real time.
// =============================================================================

import { TranscriptReader } from "../session/transcript-reader.js";
import type { SubtaskState } from "./subtasks.js";

export type PlanStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type SubtaskStatus = "running" | "completed" | "failed";

export interface PlanItem {
  id: number;
  content: string;
  status: PlanStatus;
}

export interface SubtaskNode {
  ticketId: string;
  task: string;
  status: SubtaskStatus;
  tokensUsed: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

export interface TaskTreeData {
  sessionId: string;
  plan: PlanItem[];
  subtasks: SubtaskNode[];
  /** true when the owning engine's live in-memory state was overlaid. */
  live: boolean;
}

interface RawToolEvent {
  type: "TOOL_CALL" | "TOOL_RESULT";
  timestamp?: number;
  payload?: any;
}

/** Robust JSON.parse that never throws (plan_tasks stores `tasks` as a string). */
function tryParse(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

/** Extract the delegated ticket id from a `Delegated → ticket t-xxxx` result. */
function ticketFromDelegationOutput(output: string): string | null {
  const m = String(output || "").match(/ticket\s+([A-Za-z0-9][A-Za-z0-9-]*)/i);
  return m ? m[1] : null;
}

/** Parse a `[t-xxxx] completed (12s, 340 tokens)` poll result line. */
function parsePollResult(output: string): {
  ticketId: string | null;
  status: "running" | "completed" | "failed" | null;
  secs?: number;
  tokens?: number;
} {
  const m = String(output || "").match(/\[([^\]]+)\]\s+(running|completed|failed)(?:\s+\((\d+)s,\s*(\d+)\s*tokens?\))?/i);
  if (!m) return { ticketId: null, status: null };
  return {
    ticketId: m[1],
    status: m[2].toLowerCase() as "running" | "completed" | "failed",
    secs: m[3] ? Number(m[3]) : undefined,
    tokens: m[4] ? Number(m[4]) : undefined,
  };
}

/**
 * Rebuild a session's task tree from its append-only transcript. Never throws —
 * corrupt lines are skipped, and a missing file yields an empty tree.
 */
export function rebuildTaskTreeFromTranscript(
  transcriptPath: string,
  sessionId: string,
): { plan: PlanItem[]; subtasks: SubtaskNode[] } {
  const plan: PlanItem[] = [];
  const subtasks = new Map<string, SubtaskNode>();
  // toolCallId → { args, output, timestamp } for pairing TOOL_CALL with TOOL_RESULT.
  const calls = new Map<string, { name: string; args: any; timestamp?: number }>();
  const results = new Map<string, { output: string; success: boolean }>();
  // Tool-call ids in TRANSCRIPT ORDER — used below to tell which update_todo
  // lines belong to the last task's plan (positional ids collide across tasks).
  const order: string[] = [];

  try {
    const reader = new TranscriptReader(transcriptPath);
    reader.replay((ev) => {
      const e = ev as unknown as RawToolEvent;
      if (e.type !== "TOOL_CALL" && e.type !== "TOOL_RESULT") return;
      const p = e.payload ?? {};
      if (e.type === "TOOL_CALL" && p.id && p.name) {
        calls.set(p.id, { name: p.name, args: p.args ?? {}, timestamp: e.timestamp });
        order.push(p.id);
      } else if (e.type === "TOOL_RESULT" && p.toolCallId) {
        results.set(p.toolCallId, { output: String(p.output ?? ""), success: !!p.success });
      }
    });
  } catch {
    return { plan, subtasks: [...subtasks.values()] };
  }

  const orderIdx = new Map<string, number>(); // toolCallId → index in `order`
  for (let i = 0; i < order.length; i++) orderIdx.set(order[i], i);

  // Plan items from plan_tasks / update_todo.
  // A session runs MANY tasks over its life — one plan_tasks per task. The live
  // engine's todo list only ever holds the CURRENT task (it is cleared when that
  // task completes), so rebuild the same way: the LAST plan_tasks call is the
  // tree this session shows; earlier tasks are separate history (each task lives
  // in its own session row). Otherwise multiple plans would be concatenated into
  // one list with colliding ids and garbled statuses.
  let lastPlan: Array<{ id: number; content: string }> | null = null;
  let lastPlanAt = -1; // index in `order` of the last plan_tasks call
  for (const toolCallId of order) {
    const call = calls.get(toolCallId)!;
    if (call.name !== "ouroboros:plan_tasks" && call.name !== "claude-code:plan_tasks") continue;
    const raw = tryParse(call.args?.tasks);
    const items = Array.isArray(raw) ? raw : [];
    const parsed: Array<{ id: number; content: string }> = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const content = typeof it === "string" ? it : (it && typeof it === "object" ? (it as any).content : null);
      if (typeof content !== "string" || !content.trim()) continue;
      parsed.push({ id: i + 1, content: content.trim() });
    }
    if (parsed.length > 0) {
      lastPlan = parsed;
      lastPlanAt = orderIdx.get(toolCallId) ?? -1;
    }
  }
  for (const it of lastPlan ?? []) plan.push({ id: it.id, content: it.content, status: "pending" });
  for (const toolCallId of order) {
    const call = calls.get(toolCallId)!;
    if (call.name !== "ouroboros:update_todo" && call.name !== "claude-code:update_todo") continue;
    // update_todo ids are positional within their OWN plan, so lines that ran
    // BEFORE the last plan_tasks belong to an earlier (already-superseded) task
    // and must not overwrite the last plan's steps.
    if ((orderIdx.get(toolCallId) ?? -1) <= lastPlanAt) continue;
    const id = Number(call.args?.id);
    const status = String(call.args?.status ?? "");
    const target = plan.find((p) => p.id === id);
    if (target && (status === "pending" || status === "in_progress" || status === "completed" || status === "cancelled")) {
      target.status = status;
    }
  }

  // Delegated subtasks: delegate TOOL_CALL creates a running subtask whose ticket
  // is named by its TOOL_RESULT; poll TOOL_RESULTs later flip it to done/failed.
  const delegatedToolIds = [...calls.entries()]
    .filter(([, c]) => c.name === "ouroboros:delegate" || c.name === "claude-code:delegate")
    .map(([id]) => id);

  for (const toolCallId of delegatedToolIds) {
    const call = calls.get(toolCallId);
    const res = results.get(toolCallId);
    const ticketId = (res ? ticketFromDelegationOutput(res.output) : null) ?? `t-${toolCallId.slice(0, 8)}`;
    const node: SubtaskNode = {
      ticketId,
      task: String(call?.args?.task ?? "").slice(0, 200) || "(delegated)",
      status: "running",
      tokensUsed: 0,
      startedAt: call?.timestamp,
    };
    subtasks.set(ticketId, node);
  }

  for (const [toolCallId, call] of calls) {
    if (call.name !== "ouroboros:poll" && call.name !== "claude-code:poll") continue;
    const res = results.get(toolCallId);
    if (!res) continue;
    const parsed = parsePollResult(res.output);
    const ticketId = parsed.ticketId ?? String(call.args?.ticketId ?? "");
    const node = subtasks.get(ticketId);
    if (!node) continue;
    if (parsed.status) {
      node.status = parsed.status === "running" ? "running" : parsed.status === "completed" ? "completed" : "failed";
      node.tokensUsed = parsed.tokens ?? node.tokensUsed;
      if (node.status !== "running") node.completedAt = call.timestamp;
    }
    // Body lines after the header hold the final result / error.
    const body = res.output.split("\n").slice(1).join("\n").trim();
    const errLine = res.output.match(/Error:\s*(.+)/i);
    if (node.status === "failed" && errLine) node.error = errLine[1].trim();
    if (body && node.status === "completed") node.result = body.slice(0, 4000);
  }

  return { plan, subtasks: [...subtasks.values()] };
}

/** Map a live SubtaskState into the panel's SubtaskNode shape. */
export function subtaskToNode(s: SubtaskState): SubtaskNode {
  return {
    ticketId: s.ticketId,
    task: s.task,
    status: s.status,
    tokensUsed: s.tokensUsed,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    result: s.result,
    error: s.error,
  };
}

/**
 * Overlay the owning engine's live in-memory todo list + subtask registry on the
 * rebuilt tree, tagging the result live:true. Runs only for a session this engine
 * owns — closed sessions keep the historical, non-live tree.
 */
export function overlayLive(
  base: { plan: PlanItem[]; subtasks: SubtaskNode[] },
  liveTodos: PlanItem[] | null,
  liveSubtasks: SubtaskNode[] | null,
): { plan: PlanItem[]; subtasks: SubtaskNode[]; live: boolean } {
  if (!liveTodos && !liveSubtasks) return { ...base, live: false };
  const plan = liveTodos && liveTodos.length > 0 ? liveTodos : base.plan;
  const subtasks = liveSubtasks && liveSubtasks.length > 0 ? liveSubtasks : base.subtasks;
  return { plan, subtasks, live: true };
}
