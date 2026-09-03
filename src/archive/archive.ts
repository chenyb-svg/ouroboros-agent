// =============================================================================
// src/archive/archive.ts — per-agent / per-group archive tree
//
// Mirrors every agent's state into a human-browsable folder tree so each group,
// member, and ungrouped agent has its own archive:
//
//   <dataHome>/archive/
//     index.json                       tree summary (what got archived & where)
//     <组名>/                          one folder per agent group
//       _group.yaml                    (copy of the roster / job spec pointer)
//       README.md                      group-level identity + member list
//       <成员名>/                      one subfolder per member
//         README.md                    identity (group / member / role / sessionId)
//         transcript.jsonl             copy of the raw conversation log
//         history.md                   rendered conversation (user/assistant/tool)
//         tool-flow.jsonl              TOOL_CALL + TOOL_RESULT events, one JSON per line
//         execution.json               instance + session-state snapshot, memory counts
//         git-commits.jsonl            git-related tool calls (derived — honest label)
//         task-tree.json               subtask tool calls + activeSubtasks snapshot
//         memory.jsonl                 project shared memory + longterm (snapshot)
//         workflows.md                 shared workflow registry index
//     <未分组代理>/                    one top-level folder per ungrouped agent
//       ... (same member files)
//
// Design notes:
//  - The archive is a GENERATED mirror. The single source of truth stays where
//    it already lives (sessions/, instances/, memory/, groups/).
//  - Group vs group / group vs ungrouped isolation = separate folders, on top of
//    the existing group policies (allowViewOthers / allowMessageOthers). Memory
//    STORAGE stays project-shared (agents query it themselves) — each memory.jsonl
//    header says so explicitly.
//  - Every read/write is wrapped in try/catch: a corrupt archive must never break
//    the engine.
//  - Pruning only removes Ouroboros-generated folders (marked with .ouroboros-archive)
//    whose target vanished; user-placed files are never touched.
// =============================================================================

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dataPath } from "../data-home.js";
import { groupsDir, listGroups } from "../coordination/groups.js";
import type { AgentGroup, GroupMember } from "../coordination/groups.js";

const ARCHIVE_ROOT = "archive";
/** Marker file written into every generated folder — pruning only touches these. */
const MARKER = ".ouroboros-archive";
const TXT_LIMIT = 400; // history.md output truncation

// ---- small shared helpers -----------------------------------------------------

function isoNow(): string {
  return new Date().toISOString();
}

/** Strip characters that are illegal in Windows/Unix folder names; keep CJK. */
function sanitize(name: string, fallback: string): string {
  const cleaned = String(name)
    .split("")
    .map((c) => (c.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(c) ? "_" : c))
    .join("")
    .replace(/[. ]+$/g, "")
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeMarker(dir: string): void {
  try {
    writeFileSync(join(dir, MARKER), "", "utf-8");
  } catch {
    /* best-effort */
  }
}

function hasMarker(dir: string): boolean {
  try {
    return existsSync(join(dir, MARKER));
  } catch {
    return false;
  }
}

function countLines(p: string): number {
  try {
    return readFileSync(p, "utf-8")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#")).length;
  } catch {
    return 0;
  }
}

function snippet(text: string | undefined, limit = TXT_LIMIT): string {
  if (!text) return "";
  const s = String(text);
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

// ---- instance enumeration ------------------------------------------------------

interface InstanceRecord {
  sessionId: string;
  name?: string;
  state?: string;
  groupId?: string;
  role?: string;
  currentTask?: string;
  activeSubtasks?: unknown[];
  [k: string]: unknown;
}

/** Read all instance files under <dataHome>/instances/*.json. */
function readInstances(): Map<string, InstanceRecord> {
  const out = new Map<string, InstanceRecord>();
  try {
    const dir = dataPath("instances");
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const rec = readJson<InstanceRecord>(join(dir, f));
      if (rec && rec.sessionId) out.set(rec.sessionId, rec);
    }
  } catch {
    /* no instances dir yet */
  }
  return out;
}

interface TranscriptEvent {
  type: string;
  payload?: Record<string, unknown>;
}

/** Read a session's transcript as a typed event list (tolerant of bad lines). */
function transcriptEvents(sessionId: string): TranscriptEvent[] {
  try {
    const p = dataPath("sessions", sessionId, "transcript.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l): TranscriptEvent | null => {
        try {
          const e = JSON.parse(l);
          return { type: e.type, payload: e.payload };
        } catch {
          return null;
        }
      })
      .filter((e): e is TranscriptEvent => e !== null);
  } catch {
    return [];
  }
}

// ---- per-member / per-ungrouped-agent detail files ------------------------------

interface MemberCtx {
  group?: { id: string; name: string };
  member?: GroupMember;
  instance?: InstanceRecord;
}

function writeReadme(dir: string, sessionId: string, ctx: MemberCtx): void {
  const rows: Array<[string, string]> = [
    ["会话 ID", sessionId],
    ["归档时间", isoNow()],
  ];
  if (ctx.group && ctx.member) {
    rows.unshift(["成员名", ctx.member.name]);
    rows.splice(2, 0, ["归属", `◈ ${ctx.group.name}（${ctx.member.role === "lead" ? "主代理" : "副代理"}）`]);
  } else {
    rows.unshift(["代理名", ctx.instance?.name ?? sessionId]);
    rows.splice(2, 0, ["归属", "⋯ 未分组代理"]);
  }
  rows.push(["状态", ctx.instance?.state ?? "—"]);
  if (ctx.instance?.currentTask) rows.push(["当前任务", snippet(String(ctx.instance.currentTask), 120)]);
  const lines = [`# ${rows[0][1]} 归档`];
  for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`);
  lines.push("");
  lines.push(`> 归档文件由 Ouroboros 自动生成（\`archive_rebuild\`），源数据见 \`sessions/<sessionId>/\` 等。`);
  try {
    writeFileSync(join(dir, "README.md"), lines.join("\n") + "\n", "utf-8");
  } catch {
    /* best-effort */
  }
}

function copyTranscript(dir: string, sessionId: string): void {
  try {
    const src = dataPath("sessions", sessionId, "transcript.jsonl");
    if (existsSync(src)) copyFileSync(src, join(dir, "transcript.jsonl"));
  } catch {
    /* best-effort */
  }
}

function writeHistoryMd(dir: string, sessionId: string): void {
  const events = transcriptEvents(sessionId);
  if (events.length === 0) return;
  const lines: string[] = [`# 对话记录（会话 ${sessionId}）`, "", `> 由 transcript.jsonl 渲染 · 归档时间 ${isoNow()}`, ""];
  for (const ev of events) {
    const p = ev.payload ?? {};
    if (ev.type === "USER_INPUT") {
      lines.push(`**用户**: ${snippet(String(p.text ?? ""))}`, "");
    } else if (ev.type === "LLM_RESPONSE_COMPLETE") {
      lines.push(`**助理**: ${snippet(String(p.text ?? p.fullText ?? ""))}`, "");
    } else if (ev.type === "TOOL_CALL") {
      lines.push(`**🔧 调用工具**: ${snippet(String(p.name ?? "?"))}`, "");
    } else if (ev.type === "TOOL_RESULT") {
      const toolName = snippet(String(p.name ?? p.fqn ?? "?"));
      const out = snippet(String(p.output ?? p.error ?? ""));
      lines.push(`**🔧 工具结果**（${toolName}）: ${out || "（无输出）"}`, "");
    }
  }
  try {
    writeFileSync(join(dir, "history.md"), lines.join("\n"), "utf-8");
  } catch {
    /* best-effort */
  }
}

function writeToolFlow(dir: string, sessionId: string): void {
  const events = transcriptEvents(sessionId);
  const flow = events.filter((e) => e.type === "TOOL_CALL" || e.type === "TOOL_RESULT");
  if (flow.length === 0) return;
  try {
    const body = flow.map((e) => JSON.stringify({ type: e.type, ...e.payload })).join("\n");
    writeFileSync(join(dir, "tool-flow.jsonl"), `${body}\n`, "utf-8");
  } catch {
    /* best-effort */
  }
}

function memoryCounts(): Record<string, number> {
  const projectHash = createHash("md5").update(process.cwd()).digest("hex").slice(0, 16);
  return {
    working: countLines(dataPath("memory", "projects", projectHash, "working.jsonl")),
    longterm: countLines(dataPath("memory", "global", "longterm.jsonl")),
  };
}

function writeExecution(dir: string, sessionId: string, ctx: MemberCtx): void {
  const exec: Record<string, unknown> = {
    sessionId,
    generatedAt: isoNow(),
    instance: ctx.instance ?? null,
    sessionState: readJson(dataPath("sessions", sessionId, "session-state.json")) ?? null,
    memoryCounts: memoryCounts(),
  };
  try {
    writeFileSync(join(dir, "execution.json"), JSON.stringify(exec, null, 2) + "\n", "utf-8");
  } catch {
    /* best-effort */
  }
}

function writeGitCommits(dir: string, sessionId: string): void {
  const events = transcriptEvents(sessionId);
  const rows: Array<Record<string, unknown>> = [];
  for (const ev of events) {
    if (ev.type !== "TOOL_CALL") continue;
    const p = ev.payload ?? {};
    const name = String(p.name ?? "");
    const args = (p.args ?? {}) as Record<string, unknown>;
    const command = String(args.command ?? args.cmd ?? JSON.stringify(args));
    const gitTool = /git/.test(name);
    const gitCmd = /^git\b/.test(command.trim());
    if (!gitTool && !gitCmd) continue;
    rows.push({ id: p.id, tool: name, command: snippet(command, 300), sessionId });
  }
  if (rows.length === 0) return;
  const header =
    "# git 相关工具调用（由 tool-flow.jsonl 推导；同一仓库内所有代理共享 Git 历史，本文件仅记录该代理发起的调用）";
  try {
    writeFileSync(join(dir, "git-commits.jsonl"), `${header}\n${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf-8");
  } catch {
    /* best-effort */
  }
}

function writeTaskTree(dir: string, sessionId: string, ctx: MemberCtx): void {
  const events = transcriptEvents(sessionId);
  const calls: Array<Record<string, unknown>> = [];
  for (const ev of events) {
    if (ev.type !== "TOOL_CALL") continue;
    const p = ev.payload ?? {};
    const name = String(p.name ?? "");
    if (/subtask|delegate|task/i.test(name)) calls.push({ id: p.id, tool: name, args: p.args });
  }
  const tree = {
    sessionId,
    note: "运行期任务树为内存态，此文件为可观测快照（subtask 相关工具调用 + 实例 activeSubtasks）。",
    activeSubtasks: ctx.instance?.activeSubtasks ?? [],
    subtaskCalls: calls,
  };
  try {
    writeFileSync(join(dir, "task-tree.json"), JSON.stringify(tree, null, 2) + "\n", "utf-8");
  } catch {
    /* best-effort */
  }
}

function writeMemory(dir: string): void {
  const projectHash = createHash("md5").update(process.cwd()).digest("hex").slice(0, 16);
  const working = dataPath("memory", "projects", projectHash, "working.jsonl");
  const longterm = dataPath("memory", "global", "longterm.jsonl");
  const parts: string[] = [
    "# 项目共享记忆（同项目内所有代理共享，代理自行查询；此文件为归档快照，不是唯一来源）",
  ];
  try {
    const c = readFileSync(working, "utf-8").trim();
    if (c) parts.push(c);
  } catch {
    /* no working memory yet */
  }
  parts.push("# ---- 长期记忆（全局共享） ----");
  try {
    const c = readFileSync(longterm, "utf-8").trim();
    if (c) parts.push(c);
  } catch {
    /* no longterm yet */
  }
  if (parts.length <= 1) return;
  try {
    writeFileSync(join(dir, "memory.jsonl"), parts.join("\n") + "\n", "utf-8");
  } catch {
    /* best-effort */
  }
}

function writeWorkflows(dir: string): void {
  const dirs = [dataPath("skills", "workflows"), join(process.cwd(), ".ouroboros", "skills", "workflows")];
  const files: string[] = [];
  for (const d of dirs) {
    try {
      for (const f of readdirSync(d)) {
        if (f.endsWith(".yaml") || f.endsWith(".yml")) files.push(join(d, f));
      }
    } catch {
      /* missing dir */
    }
  }
  const lines = [
    "# 工作流（共享库）",
    "",
    "> 工作流是共享库（`~/.ouroboros/skills/workflows` 与项目 `.ouroboros/skills/workflows`），不属于单个代理，此处仅做索引。",
    "",
  ];
  if (files.length === 0) lines.push("（暂无工作流）");
  else for (const f of files) lines.push(`- \`${f}\``);
  try {
    writeFileSync(join(dir, "workflows.md"), lines.join("\n") + "\n", "utf-8");
  } catch {
    /* best-effort */
  }
}

/** Write every detail file for one member (or one ungrouped agent) folder. */
function writeMemberDir(dir: string, sessionId: string, ctx: MemberCtx): void {
  mkdirSync(dir, { recursive: true });
  writeMarker(dir);
  writeReadme(dir, sessionId, ctx);
  copyTranscript(dir, sessionId);
  writeHistoryMd(dir, sessionId);
  writeToolFlow(dir, sessionId);
  writeExecution(dir, sessionId, ctx);
  writeGitCommits(dir, sessionId);
  writeTaskTree(dir, sessionId, ctx);
  writeMemory(dir);
  writeWorkflows(dir);
}

// ---- group folder metadata ------------------------------------------------------

function copyGroupYaml(g: AgentGroup, groupDir: string): void {
  try {
    const src = join(groupsDir(), g.id, "group.yaml");
    if (existsSync(src)) copyFileSync(src, join(groupDir, "_group.yaml"));
  } catch {
    /* best-effort */
  }
}

function writeGroupReadme(g: AgentGroup, groupDir: string, memberFolders: Record<string, string>): void {
  const lines = [
    `# 代理组：${g.name}`,
    "",
    "| 字段 | 值 |",
    "|---|---|",
    `| 组 ID | ${g.id} |`,
    `| 成员数 | ${g.members.length} |`,
    `| 创建时间 | ${g.createdAt} |`,
    `| 更新时间 | ${g.updatedAt} |`,
    `| 跨组可见 | ${g.allowViewOthers ? "允许" : "关闭（默认隔离）"} |`,
    `| 组外通信 | ${g.allowMessageOthers ? "允许" : "关闭（默认隔离）"} |`,
    `| 归档时间 | ${isoNow()} |`,
    "",
    "## 成员",
    "",
  ];
  for (const m of g.members) {
    lines.push(`- **${m.name}**（${m.role === "lead" ? "主代理" : "副代理"}）· \`${m.sessionId}\` → \`${memberFolders[m.sessionId] ?? "—"}/\``);
  }
  const desc = g.description ?? "";
  if (desc) {
    lines.push("", "## 职责描述", "", "> " + snippet(desc, 600).replace(/\n/g, "\n> "));
  }
  try {
    writeFileSync(join(groupDir, "README.md"), lines.join("\n") + "\n", "utf-8");
  } catch {
    /* best-effort */
  }
}

// ---- pruning ---------------------------------------------------------------------

/**
 * Remove Ouroboros-generated folders whose target vanished. Only touches dirs
 * containing the .ouroboros-archive marker. Keeps: current group dirs (and their
 * member subdirs) + current ungrouped dirs.
 */
function prune(root: string, keepGroup: Set<string>, keepMember: Set<string>, keepUngrouped: Set<string>): void {
  try {
    for (const entry of readdirSync(root)) {
      const p = join(root, entry);
      if (!hasMarker(p)) continue;
      if (!keepGroup.has(p) && !keepUngrouped.has(p)) {
        rmSync(p, { recursive: true, force: true });
        continue;
      }
      // Inside a kept group folder, prune member subfolders that vanished.
      try {
        for (const sub of readdirSync(p)) {
          const sp = join(p, sub);
          if (hasMarker(sp) && !keepMember.has(sp)) rmSync(sp, { recursive: true, force: true });
        }
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

// ---- main build -------------------------------------------------------------------

function uniqueName(used: Set<string>, base: string): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  const name = `${base}-${n}`;
  used.add(name);
  return name;
}

function build(): void {
  const root = dataPath(ARCHIVE_ROOT);
  mkdirSync(root, { recursive: true });

  const groups = listGroups();
  const instances = readInstances();
  const rosterSids = new Set<string>();

  const keepGroup = new Set<string>();
  const keepMember = new Set<string>();
  const keepUngrouped = new Set<string>();
  const usedTop = new Set<string>();

  const groupsSummary: unknown[] = [];

  // (1) Group folders + member subfolders.
  for (const g of groups) {
    const groupDirName = uniqueName(usedTop, sanitize(g.name, g.id));
    const groupDir = join(root, groupDirName);
    keepGroup.add(groupDir);
    mkdirSync(groupDir, { recursive: true });
    writeMarker(groupDir);
    copyGroupYaml(g, groupDir);

    const memberFolders: Record<string, string> = {};
    const memberIds: Array<{ name: string; role: string; sessionId: string; folder: string }> = [];
    for (const mem of g.members) {
      rosterSids.add(mem.sessionId);
      const memDirName = uniqueName(usedTop, sanitize(mem.name, mem.sessionId));
      const memDir = join(groupDir, memDirName);
      keepMember.add(memDir);
      writeMemberDir(memDir, mem.sessionId, { group: g, member: mem, instance: instances.get(mem.sessionId) });
      memberFolders[mem.sessionId] = memDirName;
      memberIds.push({ name: mem.name, role: mem.role, sessionId: mem.sessionId, folder: memDirName });
    }
    writeGroupReadme(g, groupDir, memberFolders);
    groupsSummary.push({ id: g.id, name: g.name, folder: groupDirName, members: memberIds });
  }

  // (2) Ungrouped agent folders: instances not in any roster.
  const ungroupedSummary: Array<Record<string, unknown>> = [];
  for (const [sid, rec] of instances) {
    if (rosterSids.has(sid)) continue;
    const dirName = uniqueName(usedTop, sanitize(rec.name ?? sid, sid));
    const dir = join(root, dirName);
    keepUngrouped.add(dir);
    writeMemberDir(dir, sid, { instance: rec });
    ungroupedSummary.push({ name: rec.name ?? sid, sessionId: sid, folder: dirName, state: rec.state });
  }

  // (3) Root index.
  try {
    writeFileSync(
      join(root, "index.json"),
      JSON.stringify({ generatedAt: isoNow(), groups: groupsSummary, ungrouped: ungroupedSummary }, null, 2) + "\n",
      "utf-8",
    );
  } catch {
    /* best-effort */
  }

  // (4) Prune stale generated folders.
  prune(root, keepGroup, keepMember, keepUngrouped);
}

/**
 * Rebuild the archive tree. Never throws — any failure is contained so a corrupt
 * data dir cannot break the engine loop.
 */
export function buildArchive(): void {
  try {
    build();
  } catch {
    /* archive must never break the engine */
  }
}
