// =============================================================================
// src/engine.ts — headless engine entry for the desktop client (Electron).
//
// Speaks JSONL over stdio:
//   stdin:  one JSON command per line
//   stdout: one JSON event per line   (human/CLI text goes to stderr)
//   stderr: human-readable logs
//
// It boots the exact same engine as the CLI (bootstrap(), src/repl.ts), then
// serves commands until `exit` or EOF on stdin. The desktop main process spawns
// one of these per agent panel; multiple children coordinate through the
// existing blackboard/inbox file protocol, exactly like multi-open CLI.
//
// Run:   OUROBOROS_ENGINE=1 npx tsx src/engine.ts
// =============================================================================

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { dataPath } from "./data-home.js";
import * as groups from "./coordination/groups.js";
import { buildArchive } from "./archive/archive.js";
import { listKnowledge, createKnowledge, readKnowledgeFile, writeKnowledgeFile, deleteKnowledge } from "./knowledge/knowledge.js";
import { SKILL_CATALOG } from "./knowledge/skill-catalog.js";
import { SkillInstaller } from "./cli/skill-installer.js";
import { readdirSync, readFileSync, existsSync, writeFileSync, statSync, rmSync } from "node:fs";
import { readTranscriptSummary } from "./session/transcript-summary.js";
import { fetchBalance } from "./project/balance.js";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config/loader.js";
import {
  bootstrap,
  setEngineSink,
  setPermissionDelegate,
  setAskUserDelegate,
  setInstanceState,
  setAutonomyRunner,
  setBackgroundBusy,
  startAutonomyController,
  finalizeQuery,
  engineTaskTree,
  engineCreateCheckpoint,
  engineListCheckpoints,
  engineRewind,
  engineFork,
  engineClearHistory,
  engineListInstances,
  engineListJitTokens,
  engineRevokeJitToken,
  engineListMemory,
  engineUpdateMemory,
  engineDeleteMemory,
  engineListWorkflows,
  engineCreateWorkflow,
  engineGetWorkspace,
  engineSetWorkspace,
  engineFilePreview,
  engineSessionFiles,
  engineContextOccupancy,
  engineTranslate,
} from "./repl.js";
import { rebuildTaskTreeFromTranscript } from "./orchestration/task-tree.js";
import type { EngineHandle, EngineEvent, PermissionDecision, AskUserQuestion, AskUserAnswer, AskOutcome } from "./repl.js";

// ---- protocol types ---------------------------------------------------------

type EngineCommand =
  | { cmd: "query"; id?: string; text: string }
  | { cmd: "cancel" }
  | { cmd: "permission_decision"; reqId: string; allow: boolean; scope?: "one-shot" | "session" | "all" }
  | { cmd: "ask_answer"; reqId: string; cancelled?: boolean; reason?: "user_cancel" | "timeout"; answers?: AskUserAnswer[] }
  | { cmd: "config_get" }
  | {
      cmd: "config_set";
      config?: Record<string, unknown>;
      envVars?: Record<string, string>;
      /** Dotted paths (e.g. "modelOverrides.Specialist") to DELETE after the patch
       *  is merged — deep-merge alone can never remove a record key. */
      remove?: string[];
      /** true = write `config` verbatim as the whole config.yaml (raw editor);
       *  default = deep-merge the patch over the file so partial edits never wipe
       *  unrelated keys (defaults / user-level overrides stay in place). */
      replace?: boolean;
    }
  | { cmd: "session_list" }
  | { cmd: "session_delete"; id: string }
  | { cmd: "clear_history"; sessionId?: string }
  | { cmd: "memory_query"; query?: string; limit?: number }
  | { cmd: "completions"; prefix?: string }
  | { cmd: "groups_list" }
  | { cmd: "group_create"; name: string; description?: string; descriptionFile?: { filename: string; content: string }; allowViewOthers?: boolean; allowMessageOthers?: boolean }
  | { cmd: "group_add_member"; groupId: string; sessionId: string; role: "lead" | "member"; name: string }
  | { cmd: "group_remove_member"; groupId: string; sessionId: string }
  | { cmd: "group_set_lead"; groupId: string; sessionId: string }
  | { cmd: "group_rename_member"; groupId: string; sessionId: string; name: string }
  | { cmd: "group_set_member_session"; groupId: string; oldSessionId: string; newSessionId: string; role?: "lead" | "member"; name?: string }
  | { cmd: "group_set_policy"; groupId: string; allowViewOthers?: boolean; allowMessageOthers?: boolean }
  | { cmd: "group_set_autonomy"; groupId: string; mode?: "off" | "on-message" | "patrol" | "always"; patrolIntervalMin?: number; alwaysCooldownMin?: number }
  | { cmd: "group_sync" }
  | { cmd: "set_instance_name"; name: string }
  | { cmd: "archive_rebuild" }
  | { cmd: "kb_list" }
  | { cmd: "kb_create"; name: string }
  | { cmd: "kb_read"; name: string; file: string }
  | { cmd: "kb_write"; name: string; file: string; content: string }
  | { cmd: "kb_delete"; name: string }
  | { cmd: "skill_list" }
  | { cmd: "skill_install"; name: string; repo?: string }
  | { cmd: "skill_uninstall"; name: string }
  | { cmd: "skill_update"; name: string; repo?: string }
  | { cmd: "skill_detail"; name: string }
  | { cmd: "task_tree"; sessionId?: string }
  | { cmd: "session_history" }
  | { cmd: "balance" }
  | { cmd: "git_status" }
  | { cmd: "git_file_diff"; path?: string }
  | { cmd: "git_commit"; message?: string }
  | { cmd: "git_push" }
  | { cmd: "git_init" }
  | { cmd: "checkpoint_create"; label?: string }
  | { cmd: "checkpoint_list" }
  | { cmd: "checkpoint_rewind"; id?: string }
  | { cmd: "session_fork" }
  | { cmd: "instances_list" }
  | { cmd: "memory_list"; keyword?: string }
  | { cmd: "memory_update"; id: string; fact?: string; category?: string }
  | { cmd: "memory_delete"; id: string }
  | { cmd: "workflow_list" }
  | { cmd: "recipe_list" }
  | { cmd: "workflow_create"; name: string; description?: string; steps: Array<{ prompt: string; tools?: string[] }> }
  | { cmd: "permissions_list" }
  | { cmd: "permissions_revoke"; id?: string }
  | { cmd: "workspace_get" }
  | { cmd: "workspace_set"; dir?: string }
  | { cmd: "file_preview"; path?: string }
  | { cmd: "session_files"; sessionId?: string }
  | { cmd: "translate"; id?: string; text?: string; target?: "zh" | "en" }
  | { cmd: "exit" };

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** Push the engine's current estimated context occupancy. Called right after a
 *  history re-push (boot / session_history / rewind) so the token ring shows real
 *  usage instead of staying gray until the first message or usage chunk. */
function emitContextOccupancy(): void {
  const occ = engineContextOccupancy();
  if (occ.ctxUsage > 0) {
    emit({ type: "context", ctxUsage: occ.ctxUsage, ctxWin: occ.ctxWin });
  }
}

// ---- permission delegation --------------------------------------------------

const pendingPermissions = new Map<string, (d: PermissionDecision) => void>();
/** 120s backstop so a desktop that never answers doesn't hang the agent forever. */
const PERMISSION_TIMEOUT_MS = 120_000;

function attachPermissionDelegate(handle: EngineHandle): void {
  setPermissionDelegate(async (toolName, args) => {
    const reqId = randomUUID();
    return await new Promise<PermissionDecision>((resolveDecision) => {
      const timer = setTimeout(() => {
        pendingPermissions.delete(reqId);
        resolveDecision(false); // timeout → deny (matches headless non-TTY fallback)
      }, PERMISSION_TIMEOUT_MS);
      pendingPermissions.set(reqId, (d) => {
        clearTimeout(timer);
        resolveDecision(d);
      });
      emit({ type: "permission_request", id: reqId, tool: toolName, args });
    });
  });
}

function handlePermissionDecision(cmd: Extract<EngineCommand, { cmd: "permission_decision" }>): void {
  const resolveDecision = pendingPermissions.get(cmd.reqId);
  if (!resolveDecision) { emit({ type: "error", message: `unknown permission request: ${cmd.reqId}` }); return; }
  pendingPermissions.delete(cmd.reqId);
  resolveDecision(cmd.allow ? (cmd.scope === "all" ? "all" : cmd.scope === "session" ? "session" : true) : false);
}

// ---- ask_user delegation ----------------------------------------------------
// Mirrors the permission delegate but for the model-invocable ask_user tool. The
// desktop answers via an ask_answer command; until then the tool call (and the
// query turn) BLOCKS. Unanswered asks are NOT refused — the desktop parks them
// with a WeChat-style red dot and the model waits up to ASK_TIMEOUT_MS, then the
// delegate resolves to a graceful timeout the model can proceed from.

const pendingAsks = new Map<string, { resolve: (o: AskOutcome) => void; timer: ReturnType<typeof setTimeout> }>();
/** Generous backstop so a desktop that never answers doesn't wedge the agent. */
const ASK_TIMEOUT_MS = 600_000;

function resolveAsk(reqId: string, outcome: AskOutcome): void {
  const entry = pendingAsks.get(reqId);
  if (!entry) return; // already resolved (timeout/cancel) — silent
  pendingAsks.delete(reqId);
  clearTimeout(entry.timer);
  entry.resolve(outcome);
}

function attachAskDelegate(): void {
  setAskUserDelegate(async (questions, context) => {
    const reqId = randomUUID();
    return await new Promise<AskOutcome>((resolveDecision) => {
      const timer = setTimeout(() => {
        const entry = pendingAsks.get(reqId);
        if (!entry) return;
        pendingAsks.delete(reqId);
        clearTimeout(entry.timer);
        entry.resolve({ status: "cancelled", reason: "timeout" });
        emit({ type: "ask_timeout", id: reqId });
      }, ASK_TIMEOUT_MS);
      pendingAsks.set(reqId, { resolve: resolveDecision, timer });
      emit({ type: "ask_request", id: reqId, questions, ...(context !== undefined ? { context } : {}) });
    });
  });
}

function handleAskAnswer(cmd: Extract<EngineCommand, { cmd: "ask_answer" }>): void {
  if (cmd.cancelled) {
    resolveAsk(cmd.reqId, { status: "cancelled", reason: cmd.reason === "timeout" ? "timeout" : "user_cancel" });
  } else {
    resolveAsk(cmd.reqId, { status: "answered", answers: cmd.answers ?? [] });
  }
}

/** User stopped the agent → every parked ask is cancelled so the blocked turn can
 *  unwind instead of wedging until its 10-min backstop. */
function cancelAllPendingAsks(): void {
  for (const [reqId, entry] of [...pendingAsks]) {
    clearTimeout(entry.timer);
    entry.resolve({ status: "cancelled", reason: "user_cancel" });
    pendingAsks.delete(reqId);
  }
}

// ---- query single-flight ----------------------------------------------------

const queryQueue: Array<{ id: string; text: string; source: "user" | "autonomous" }> = [];
let queryBusy = false;
let cancelled = false;

async function pumpQuery(handle: EngineHandle): Promise<void> {
  if (queryBusy) return;
  const q = queryQueue.shift();
  if (!q) return;
  queryBusy = true;
  cancelled = false;
  setInstanceState("reasoning", q.text);
  emit({ type: "state", id: q.id, state: "reasoning", currentTask: q.text.slice(0, 120), source: q.source });
  try {
    const text = await handle.query(q.text, q.source);
    await finalizeQuery(q.text, text);
    emit({ type: "done", id: q.id, text, cancelled, source: q.source });
  } catch (e: any) {
    try { await finalizeQuery(q.text, ""); } catch {}
    emit({ type: "error", id: q.id, message: String(e?.message ?? e) });
  } finally {
    queryBusy = false;
    setBackgroundBusy(false); // an autonomous turn finished/queued → responder unblocked
    setInstanceState("idle");
    emit({ type: "state", state: "idle", source: q.source });
    pumpQuery(handle);
  }
}

// ---- session listing (mirrors `ourob sessions`) -----------------------------

function listSessions(): Array<{ id: string; title: string; createdAt: string | null; updatedAt: string | null; preview: string; msgCount: number; resumable: boolean; owner: { agentId: string; name: string } | null }> {
  const dir = dataPath("sessions");
  const out: Array<{ id: string; title: string; createdAt: string | null; updatedAt: string | null; preview: string; msgCount: number; resumable: boolean; owner: { agentId: string; name: string } | null }> = [];
  if (!existsSync(dir)) return out;
  for (const s of readdirSync(dir)) {
    const base = join(dir, s);
    if (!existsSync(join(base, "meta.json"))) continue;
    const tPath = join(base, "transcript.jsonl");
    const sum = readTranscriptSummary(tPath);
    let title = sum.title;
    let createdAt: string | null = null;
    let resumable = false;
    let owner: { agentId: string; name: string } | null = null;
    try {
      const m = JSON.parse(readFileSync(join(base, "meta.json"), "utf-8"));
      if (m.title) title = m.title;
      createdAt = m.createdAt ?? null;
      // resume actually replays transcript.jsonl (session-state is only a fallback),
      // so "resumable" must mean "the transcript has content" — otherwise a deleted
      // agent's session (no session-state.json, transcript intact) would lose its
      // 恢复 button in the desktop session list and become unrecoverable.
      resumable = sum.msgCount > 0;
      if (m.owner && typeof m.owner.agentId === "string" && typeof m.owner.name === "string") {
        owner = { agentId: m.owner.agentId, name: m.owner.name };
      }
    } catch { /* keep defaults */ }
    let updatedAt: string | null = null;
    try { updatedAt = existsSync(tPath) ? new Date(statSync(tPath).mtimeMs).toISOString() : null; } catch {}
    // Skip sessions with no user content at all (every engine boot creates an empty
    // session dir; they have nothing to preview or resume and would clutter the list).
    if (sum.msgCount === 0 && !sum.title && !sum.preview) continue;
    out.push({ id: s, title: title || "…", createdAt, updatedAt, preview: sum.preview, msgCount: sum.msgCount, resumable, owner });
  }
  // Most recent activity first; fall back to creation time for sessions with no transcript.
  out.sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || ""));
  return out;
}

// ---- agent-group summaries (the desktop reads these to build the overview) ----

function groupSummary(g: groups.AgentGroup) {
  const policy = groups.groupPolicy(g);
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    descriptionPath: g.descriptionPath,
    memberCount: g.members.length,
    allowViewOthers: policy.allowViewOthers,
    allowMessageOthers: policy.allowMessageOthers,
    autonomy: groups.groupAutonomy(g),
    members: g.members.map((m) => ({ sessionId: m.sessionId, role: m.role, name: m.name })),
  };
}

// ---- config persistence (same semantics as the switch web page) -------------

/** Deep-merge `patch` over `base` (objects recurse, everything else replaces). */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return patch;
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge(out[k], v);
  }
  return out;
}

/** The effective config after the last config_set write — config_get serves this
 *  (or the boot-time handle.config) so the desktop always reads post-save truth. */
let liveConfig: ReturnType<typeof loadConfig> | null = null;

/** Delete `a.b.c` from an object tree (dots = nesting; a bare key deletes that key). */
function deleteDottedPath(obj: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur === null || typeof cur !== "object") return;
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  if (cur !== null && typeof cur === "object" && !Array.isArray(cur)) {
    delete (cur as Record<string, unknown>)[parts[parts.length - 1]];
  }
}

async function saveConfig(cmd: Extract<EngineCommand, { cmd: "config_set" }>): Promise<void> {
  if (!cmd.config || typeof cmd.config !== "object" || Array.isArray(cmd.config)) {
    emit({ type: "error", message: "config_set: config object required" });
    return;
  }
  try {
    const yaml = await import("js-yaml");
    const cfgPath = resolve(process.cwd(), ".ouroboros", "config.yaml");
    // Merge over the *file's* current content so a partial settings patch never
    // wipes unrelated keys (defaults / user-level overrides stay in place).
    let base: unknown = {};
    if (existsSync(cfgPath)) {
      try { base = yaml.load(readFileSync(cfgPath, "utf-8")) ?? {}; } catch { base = {}; }
    }
    const merged: Record<string, unknown> = cmd.replace === true
      ? (cmd.config as Record<string, unknown>)
      : (deepMerge(base, cmd.config) as Record<string, unknown>);
    if (Array.isArray(cmd.remove)) {
      for (const p of cmd.remove) if (typeof p === "string") deleteDottedPath(merged, p);
    }
    writeFileSync(cfgPath, yaml.dump(merged, { indent: 2, lineWidth: 120, quotingType: "\"" }), "utf-8");
    if (cmd.envVars && typeof cmd.envVars === "object") {
      const envPath = resolve(process.cwd(), ".env");
      let content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
      for (const [k, v] of Object.entries(cmd.envVars)) {
        const re = new RegExp(`^${k}=.*$`, "m");
        content = re.test(content) ? content.replace(re, `${k}=${v}`) : `${content}${content.endsWith("\n") || !content ? "" : "\n"}${k}=${v}\n`;
      }
      writeFileSync(envPath, content, "utf-8");
      for (const k of Object.keys(cmd.envVars)) process.env[k] = cmd.envVars[k];
    }
    // Push back the freshly merged *effective* config (defaults + file + env), so
    // the desktop settings UI reflects exactly what the next engine boot resolves.
    liveConfig = loadConfig();
    emit({ type: "config", config: liveConfig, ok: true });
  } catch (e: any) {
    emit({ type: "error", message: `config_set: ${e?.message ?? e}` });
  }
}

// ---- main loop --------------------------------------------------------------

async function serve(handle: EngineHandle): Promise<void> {
  setEngineSink((ev: EngineEvent) => emit(ev));
  attachPermissionDelegate(handle);
  attachAskDelegate();

  // Autonomous turns originate in the in-process AutonomyController (repl.ts).
  // The runner pushes onto the SAME FIFO and pumps it, so the desktop sees full
  // engine protocol events (state/tool_*/done/idle) tagged source="autonomous",
  // and the FIFO order serializes cleanly against user queries. setBackgroundBusy
  // closes the Responder race (it must not start an LLM call during the gap before
  // enqueueQuery latches mainQueryActive).
  setAutonomyRunner((input, opts) => {
    setBackgroundBusy(true);
    queryQueue.push({ id: randomUUID(), text: input, source: opts?.source === "user" ? "user" : "autonomous" });
    pumpQuery(handle);
  });
  // Start the poller only after the runner is wired (its first tick may fire
  // immediately) — otherwise an early tick would silently no-op.
  startAutonomyController();

  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    let cmd: EngineCommand;
    try { cmd = JSON.parse(line); } catch {
      emit({ type: "error", message: "invalid JSON command" });
      continue;
    }
    switch (cmd.cmd) {
      case "query":
        if (typeof cmd.text !== "string" || !cmd.text.trim()) { emit({ type: "error", message: "query: text required" }); break; }
        queryQueue.push({ id: cmd.id ?? randomUUID(), text: cmd.text, source: "user" });
        pumpQuery(handle);
        break;
      case "cancel":
        cancelled = true;
        handle.abort();
        cancelAllPendingAsks();
        break;
      case "permission_decision":
        handlePermissionDecision(cmd);
        break;
      case "ask_answer":
        handleAskAnswer(cmd);
        break;
      case "config_get":
        emit({ type: "config", config: liveConfig ?? handle.config });
        break;
      case "config_set":
        await saveConfig(cmd);
        break;
      case "session_list":
        emit({ type: "session_list", sessions: listSessions() });
        break;
      case "session_delete": {
        // Permanently remove a session record (the desktop's terminal tier — after
        // this the conversation can never be restored). Only safe when no engine is
        // currently writing to it; the desktop refuses live-owner deletes before
        // sending, this guard protects this engine's own pinned session.
        const sid = cmd.id;
        if (typeof sid !== "string" || !sid.trim()) { emit({ type: "session_deleted", ok: false, id: "", error: "session_delete: id required" }); break; }
        if (sid === handle.sessionId) { emit({ type: "session_deleted", ok: false, id: sid, error: "cannot delete the session this engine is writing to" }); break; }
        const dir = dataPath("sessions", sid);
        if (!existsSync(dir)) { emit({ type: "session_deleted", ok: true, id: sid, already: true }); break; }
        try {
          rmSync(dir, { recursive: true, force: true });
          emit({ type: "session_deleted", ok: true, id: sid });
        } catch (err) {
          emit({ type: "session_deleted", ok: false, id: sid, error: String(err) });
        }
        break;
      }
      case "clear_history": {
        // WeChat-style wipe, NOT the terminal session_delete: the transcript and
        // session-state are ARCHIVED (renamed to a dated .bak) and — when this
        // engine owns the session — the in-memory conversation is emptied. The
        // session dir / agent contact / checkpoints are all kept. A foreign
        // sessionId routes here through the system engine and is handled on disk
        // only, so no live engine is disturbed.
        const sid = cmd.sessionId && cmd.sessionId.trim() ? cmd.sessionId.trim() : handle.sessionId;
        const r = engineClearHistory(sid);
        if (!r.ok) {
          emit({ type: "error", message: r.error ?? "clear_history failed" });
          break;
        }
        emit({ type: "session_cleared", sessionId: sid });
        // This engine's own chat just emptied — tell the desktop immediately so its
        // file chips clear without waiting for the next session_files push. (The
        // rebuilt empty transcript rescan reports no files, so this stays accurate.)
        if (sid === handle.sessionId) emit({ type: "files", sessionId: sid, files: [] });
        break;
      }
      case "memory_query": {
        const res = handle.queryMemory(String(cmd.query ?? ""), Number(cmd.limit ?? 5));
        emit({ type: "memory_result", query: cmd.query ?? "", results: res });
        break;
      }
      case "completions": {
        const prefix = String(cmd.prefix ?? "");
        emit({ type: "completions", prefix, items: handle.completions(prefix) });
        break;
      }
      case "groups_list":
        emit({ type: "groups_list", groups: groups.listGroups().map(groupSummary) });
        break;
      case "group_create": {
        try {
          const g = groups.createGroup({
            name: cmd.name,
            description: cmd.description,
            descriptionFile: cmd.descriptionFile,
            allowViewOthers: cmd.allowViewOthers,
            allowMessageOthers: cmd.allowMessageOthers,
          });
          emit({ type: "group_created", group: groupSummary(g) });
          emit({ type: "groups_list", groups: groups.listGroups().map(groupSummary) });
          buildArchive();
        } catch (e: any) {
          emit({ type: "error", message: `group_create: ${e?.message ?? e}` });
        }
        break;
      }
      case "group_add_member": {
        const g = groups.addMember(cmd.groupId, { sessionId: cmd.sessionId, role: cmd.role, name: cmd.name });
        if (!g) { emit({ type: "error", message: "group_add_member: failed (bad group id, or member already belongs to another group)" }); break; }
        emit({ type: "groups_list", groups: groups.listGroups().map(groupSummary) });
        buildArchive();
        break;
      }
      case "group_remove_member": {
        const g = groups.removeMember(cmd.groupId, cmd.sessionId);
        if (!g) { emit({ type: "error", message: "group_remove_member: group not found" }); break; }
        emit({ type: "groups_list", groups: groups.listGroups().map(groupSummary) });
        buildArchive();
        break;
      }
      case "group_set_lead": {
        const g = groups.setLead(cmd.groupId, cmd.sessionId);
        if (!g) { emit({ type: "error", message: "group_set_lead: member not found in group" }); break; }
        emit({ type: "groups_list", groups: groups.listGroups().map(groupSummary) });
        buildArchive();
        break;
      }
      case "group_rename_member": {
        const g = groups.renameMember(cmd.groupId, cmd.sessionId, cmd.name);
        if (!g) { emit({ type: "error", message: "group_rename_member: member not found in group, or name invalid / taken in this group" }); break; }
        emit({ type: "groups_list", groups: groups.listGroups().map(groupSummary) });
        buildArchive();
        break;
      }
      case "group_set_member_session": {
        // Heal a drifted roster: an engine whose sessionId changed still belongs
        // to the group. Rotate old→new atomically; if the old key is gone (the
        // member was never registered), fall back to add — an idempotent upsert.
        let g = groups.rotateMemberSession(cmd.groupId, cmd.oldSessionId, cmd.newSessionId);
        if (!g && cmd.role && cmd.name) {
          g = groups.addMember(cmd.groupId, { sessionId: cmd.newSessionId, role: cmd.role, name: cmd.name });
        }
        if (!g) { emit({ type: "error", message: "group_set_member_session: member not found (old key missing and no add fallback), or new id already in another group" }); break; }
        emit({ type: "groups_list", groups: groups.listGroups().map(groupSummary) });
        buildArchive();
        break;
      }
      case "group_set_policy": {
        const g = groups.setGroupPolicy(cmd.groupId, {
          allowViewOthers: cmd.allowViewOthers,
          allowMessageOthers: cmd.allowMessageOthers,
        });
        if (!g) { emit({ type: "error", message: "group_set_policy: group not found" }); break; }
        emit({ type: "groups_list", groups: groups.listGroups().map(groupSummary) });
        buildArchive();
        break;
      }
      case "group_set_autonomy": {
        const g = groups.setGroupAutonomy(cmd.groupId, {
          mode: cmd.mode,
          patrolIntervalMin: cmd.patrolIntervalMin,
          alwaysCooldownMin: cmd.alwaysCooldownMin,
        });
        if (!g) { emit({ type: "error", message: "group_set_autonomy: group not found" }); break; }
        emit({ type: "groups_list", groups: groups.listGroups().map(groupSummary) });
        buildArchive();
        break;
      }
      case "group_sync": {
        const m = handle.syncGroupContext?.() ?? null;
        emit({ type: "group_synced", groupId: m?.groupId ?? null, role: m?.role ?? null });
        break;
      }
      case "set_instance_name":
        handle.setInstanceName?.(cmd.name);
        emit({ type: "instance_renamed", name: cmd.name });
        break;
      case "archive_rebuild":
        buildArchive();
        emit({ type: "archive_rebuilt" });
        break;
      case "kb_list":
        emit({ type: "kb_list", kbs: listKnowledge() });
        break;
      case "kb_create": {
        const r = createKnowledge(cmd.name);
        if (!r.ok) { emit({ type: "error", message: `kb_create: ${r.error}` }); break; }
        emit({ type: "kb_list", kbs: listKnowledge() });
        break;
      }
      case "kb_read": {
        const r = readKnowledgeFile(cmd.name, cmd.file);
        if (!r.ok) { emit({ type: "error", message: `kb_read: ${r.error}` }); break; }
        emit({ type: "kb_content", name: r.name ?? cmd.name, file: r.file ?? cmd.file, content: r.content ?? "" });
        break;
      }
      case "kb_write": {
        const r = writeKnowledgeFile(cmd.name, cmd.file, cmd.content);
        if (!r.ok) { emit({ type: "error", message: `kb_write: ${r.error}` }); break; }
        emit({ type: "kb_list", kbs: listKnowledge() });
        break;
      }
      case "kb_delete": {
        const r = deleteKnowledge(cmd.name);
        if (!r.ok) { emit({ type: "error", message: `kb_delete: ${r.error}` }); break; }
        emit({ type: "kb_list", kbs: listKnowledge() });
        break;
      }
      case "skill_list": {
        const installer = new SkillInstaller();
        emit({ type: "skill_list", installed: installer.listInstalled(), catalog: SKILL_CATALOG });
        break;
      }
      case "skill_install": {
        const installer = new SkillInstaller();
        const meta = installer.installFromGitHub(cmd.name, cmd.repo);
        if (!meta) emit({ type: "error", message: `skill_install: 安装 ${cmd.name} 失败` });
        emit({ type: "skill_list", installed: installer.listInstalled(), catalog: SKILL_CATALOG });
        break;
      }
      case "skill_uninstall": {
        const installer = new SkillInstaller();
        const r = installer.uninstall(cmd.name);
        if (!r.ok) emit({ type: "error", message: `skill_uninstall: ${r.error}` });
        emit({ type: "skill_list", installed: installer.listInstalled(), catalog: SKILL_CATALOG });
        break;
      }
      case "skill_update": {
        const installer = new SkillInstaller();
        const r = installer.update(cmd.name, cmd.repo);
        if (!r.ok) emit({ type: "error", message: `skill_update: ${r.error}` });
        emit({ type: "skill_list", installed: installer.listInstalled(), catalog: SKILL_CATALOG });
        break;
      }
      case "skill_detail": {
        const installer = new SkillInstaller();
        emit({ type: "skill_detail", name: cmd.name, meta: installer.loadMeta(cmd.name), content: installer.loadFullContent(cmd.name) });
        break;
      }
      case "task_tree": {
        const sid = cmd.sessionId || handle.sessionId;
        const data = sid === handle.sessionId
          ? engineTaskTree()
          : { sessionId: sid, ...rebuildTaskTreeFromTranscript(dataPath("sessions", sid, "transcript.jsonl"), sid), live: false };
        emit({ type: "task_tree", ...data });
        break;
      }
      // On-demand re-push of the restored conversation. The desktop calls this when
      // it focused an agent whose transcript never arrived (boot-race loss) so the
      // chat refills without an engine restart. Mirrors the boot-time history emit.
      case "session_history": {
        const history = handle.history();
        if (history.length > 0) {
          emit({ type: "history", sessionId: handle.sessionId, messages: history, usageState: handle.persistentUsage() });
          emitContextOccupancy();
        }
        break;
      }
      case "balance": {
        void (async () => {
          const m = (handle.config?.model ?? {}) as unknown as Record<string, unknown>;
          const baseUrl = String(m.apiEndpoint || "https://api.deepseek.com").replace(/\/+$/, "");
          const model = String(m.name || m.model || "");
          const provider = String(m.provider || "");
          const r = await fetchBalance({ baseUrl, apiKey: process.env.DEEPSEEK_API_KEY });
          emit({ type: "balance", ...r, model, provider });
        })();
        break;
      }
      case "git_status": {
        const s = handle.gitStatus();
        emit({ type: "git_status", ...s });
        break;
      }
      case "git_file_diff": {
        const d = handle.gitFileDiff(cmd.path ?? "");
        emit({ type: "git_file_diff", ok: true, path: cmd.path ?? "", ...d });
        break;
      }
      case "git_commit": {
        const r = handle.gitCommit(cmd.message ?? "");
        emit({ type: "git_committed", ok: r.ok, hash: r.hash ?? "", message: cmd.message ?? "", error: r.error });
        if (r.ok) {
          const s = handle.gitStatus();
          emit({ type: "git_status", ...s });
        }
        break;
      }
      case "git_push": {
        const r = handle.gitPush();
        emit({ type: "git_pushed", ok: r.ok, error: r.error });
        break;
      }
      case "git_init": {
        const r = handle.gitInit();
        emit({ type: "git_inited", ok: r.ok, error: r.error });
        if (r.ok) {
          const s = handle.gitStatus();
          emit({ type: "git_status", ...s });
        }
        break;
      }
      case "checkpoint_create": {
        const r = engineCreateCheckpoint(cmd.label);
        emit({ type: "checkpoint_created", ok: r.ok, checkpoint: r.checkpoint ?? null, error: r.error });
        break;
      }
      case "checkpoint_list": {
        const r = engineListCheckpoints();
        emit({ type: "checkpoint_list", ok: r.ok, checkpoints: r.checkpoints ?? [], error: r.error });
        break;
      }
      case "checkpoint_rewind": {
        const r = engineRewind(cmd.id ?? "");
        if (r.ok) {
          emit({ type: "rewound", ok: true, checkpointId: r.checkpointId, messagesRestored: r.messagesRestored });
          // Re-push the restored conversation so the desktop chat rewinds immediately.
          emit({ type: "history", sessionId: handle.sessionId, messages: handle.history(), usageState: handle.persistentUsage() });
          emitContextOccupancy();
        } else {
          emit({ type: "rewound", ok: false, checkpointId: r.checkpointId, messagesRestored: 0, error: r.error });
        }
        break;
      }
      case "session_fork": {
        const r = engineFork();
        emit({ type: "session_forked", ok: r.ok, newSessionId: r.newSessionId ?? "", messageCount: r.messageCount ?? 0, error: r.error });
        break;
      }
      case "instances_list": {
        const instances = engineListInstances().map((o: any) => ({
          sessionId: o.sessionId,
          name: o.name,
          state: o.state,
          currentTask: o.currentTask ?? o.lastTask ?? "",
          lastTask: o.lastTask ?? "",
          lastResult: o.lastResult ?? "",
          activeSubtasks: Array.isArray(o.activeSubtasks) ? o.activeSubtasks.length : 0,
          model: o.model ?? "",
          cwd: o.cwd ?? "",
          heartbeat: o.heartbeat ?? 0,
        }));
        emit({ type: "instances_list", instances });
        break;
      }
      case "memory_list": {
        const r = engineListMemory(cmd.keyword);
        emit({ type: "memory_list", entries: r.entries, counts: r.counts });
        break;
      }
      case "memory_update": {
        const r = engineUpdateMemory(cmd.id, { fact: cmd.fact, category: cmd.category });
        if (!r.ok) { emit({ type: "error", message: `memory_update: ${r.error}` }); break; }
        const fresh = engineListMemory();
        emit({ type: "memory_list", entries: fresh.entries, counts: fresh.counts });
        break;
      }
      case "memory_delete": {
        const r = engineDeleteMemory(cmd.id);
        if (!r.ok) { emit({ type: "error", message: `memory_delete: ${r.error}` }); break; }
        const fresh = engineListMemory();
        emit({ type: "memory_list", entries: fresh.entries, counts: fresh.counts });
        break;
      }
      case "workflow_list":
        emit({ type: "workflow_list", items: engineListWorkflows() });
        break;
      case "recipe_list":
        emit({ type: "recipe_list", items: engineListWorkflows() });
        break;
      case "workflow_create": {
        const r = engineCreateWorkflow({ name: cmd.name, description: cmd.description, steps: cmd.steps ?? [] });
        if (!r.ok) { emit({ type: "error", message: `workflow_create: ${r.error}` }); break; }
        emit({ type: "workflow_list", items: engineListWorkflows() });
        emit({ type: "recipe_list", items: engineListWorkflows() });
        break;
      }
      case "permissions_list":
        emit({ type: "permissions_list", tokens: engineListJitTokens() });
        break;
      case "permissions_revoke": {
        const r = engineRevokeJitToken(cmd.id ?? "");
        emit({ type: "permissions_revoked", ok: r.ok, id: cmd.id ?? "", error: r.error });
        emit({ type: "permissions_list", tokens: engineListJitTokens() });
        break;
      }
      case "workspace_get":
        emit({ type: "workspace", ...engineGetWorkspace() });
        break;
      case "workspace_set": {
        const r = engineSetWorkspace(cmd.dir ?? "");
        emit({ type: "workspace", root: r.root, ok: r.ok, error: r.error });
        break;
      }
      case "file_preview": {
        // Deferred one tick so a multi-MB base64 encode never blocks the shared
        // system engine's command pump (preview requests from other agents queue up).
        void (async () => {
          const r = engineFilePreview(cmd.path ?? "");
          emit({ type: "file_preview", ...r });
        })();
        break;
      }
      case "session_files": {
        // Same deferral: hashing/stat-ing the index is done off the hot path.
        void (async () => {
          const files = engineSessionFiles(cmd.sessionId);
          emit({ type: "files", sessionId: cmd.sessionId && cmd.sessionId.trim() ? cmd.sessionId : handle.sessionId, files });
        })();
        break;
      }
      case "translate": {
        // One-shot zh↔en completion (chat right-click "翻译"). Deferred like
        // file_preview so a slow model never blocks the command pump / a running
        // query; the caller matches the reply by id.
        const tid = cmd.id ?? randomUUID();
        void (async () => {
          const r = await engineTranslate(String(cmd.text ?? ""), cmd.target === "zh" ? "zh" : "en");
          emit({ type: "translated", id: tid, ok: r.ok, ...(r.ok ? { text: r.text } : {}), ...(r.error ? { error: r.error } : {}) });
        })();
        break;
      }
      case "exit":
        try { await finalizeQuery("", ""); } catch {}
        process.exit(0);
        break;
      default:
        emit({ type: "error", message: `unknown command: ${(cmd as any).cmd}` });
    }
  }
  // stdin EOF → the desktop closed the pipe → exit gracefully.
  try { await finalizeQuery("", ""); } catch {}
  process.exit(0);
}

// ---- entry ------------------------------------------------------------------

async function main(): Promise<void> {
  const handle = await bootstrap();
  // Handshake: tell the parent our session id as soon as we're ready to serve.
  // The desktop uses it to resume-restart this engine after config changes.
  emit({ type: "ready", sessionId: handle.sessionId, state: "idle" });
  // If we started via `resume <id>`, the conversation was restored in memory —
  // push it to the desktop so the chat isn't blank after a config restart or a
  // session-list resume.
  const history = handle.history();
  if (history.length > 0) {
    emit({ type: "history", sessionId: handle.sessionId, messages: history, usageState: handle.persistentUsage() });
    emitContextOccupancy();
  }
  // Under OUROBOROS_TEST=1 the repl.ts seam exposes setDeps; tests inject a fake
  // provider via OUROBOROS_TEST_PROVIDER_MODULE so no real API call is made.
  if (process.env.OUROBOROS_TEST === "1" && process.env.OUROBOROS_TEST_PROVIDER_MODULE) {
    try {
      const modUrl = pathToFileURL(resolve(process.cwd(), process.env.OUROBOROS_TEST_PROVIDER_MODULE)).href;
      const mod = await import(modUrl);
      const deps = (mod as any).default ?? mod;
      (globalThis as any).__ouroborosTest?.setDeps(deps);
    } catch (e: any) {
      process.stderr.write(`[engine] fake provider injection failed: ${e?.message ?? e}\n`);
    }
  }
  await serve(handle);
}

const isDirectRun = (() => {
  try {
    const a = process.argv[1];
    if (!a) return false;
    return /[\\/]engine\.(ts|js)$/.test(a.replace(/\\/g, "/"));
  } catch { return false; }
})();

if (isDirectRun && (process.env.OUROBOROS_ENGINE === "1" || process.env.OUROBOROS_TEST === "1")) {
  main().catch((e) => {
    process.stderr.write(`[engine] fatal: ${e?.message ?? e}\n`);
    process.exit(1);
  });
}
