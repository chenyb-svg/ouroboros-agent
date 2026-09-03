// =============================================================================
// Groups — 代理组 registry + cross-group policy (the "组织架构图" + "门禁制度")
//
// A group is NOT a process and NOT an agent — it is a registry entry on disk:
//   ~/.ouroboros/groups/<groupId>/group.yaml
// Its members are plain instances (identified by sessionId, the same key the
// blackboard/inbox use). One member is the lead (主代理, orchestrator); the rest
// are members (副代理). A lead is just an instance whose system prompt carries a
// "## Group Context" section telling it who its members are and to delegate via
// ouroboros:ask / ouroboros:send_message.
//
// Policy (the security boundary):
//   - Intra-group ask/send_message: auto-allowed (no permission prompt).
//   - Cross-group ask/send_message: must pass the existing permission prompt.
//   - Ungrouped sender: NO gate (legacy multi-open CLI behaves byte-identically;
//     isolation is the OPT-IN choice of groups, not imposed on the rest).
//   - Cross-group READ access: the dangerous `ouroboros:group_inspect` tool, which
//     therefore always asks the user via the existing modal.
//
// Every read path is wrapped in try/catch and returns empty/null — a corrupt or
// missing groups/ dir must never break boot or the query loop.
// =============================================================================

import yaml from "js-yaml";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dataPath } from "../data-home.js";

/** Block path traversal — mirrors TARGET_RE in inbox.ts. */
export const GROUP_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const SESSION_ID_RE = /^[0-9A-Za-z-]{4,64}$/;

export type GroupRole = "lead" | "member";

export interface GroupMember {
  sessionId: string;
  role: GroupRole;
  name: string;
}

export interface AgentGroup {
  id: string;
  name: string;
  /** Inline role/responsibility description (the lead's job definition). */
  description?: string;
  /** When set, the description lives in a file (e.g. an uploaded .md). */
  descriptionPath?: string;
  members: GroupMember[];
  createdAt: string;
  updatedAt: string;
  /**
   * Cross-group visibility policy (base-config toggles, default false = isolated).
   *  - allowViewOthers: may this group's agents see OTHER groups' / ungrouped
   *    instances' running status? The ouroboros:instances tool filters the
   *    roster to same-group instances when false (the old per-turn "Active
   *    Instances" prompt section was removed — the roster is now on-demand).
   *  - allowMessageOthers: may this group's agents ask/send_message outside the
   *    group? When false, cross-group messaging is hard-denied (no permission
   *    prompt). When true, the existing cross-group permission prompt applies.
   */
  allowViewOthers?: boolean;
  allowMessageOthers?: boolean;
  /**
   * Per-group autonomous-running policy (off by default = current behavior).
   *  - off:        the group's agents only act when the user sends a message.
   *  - on-message: an incoming `note` wakes the receiving agent to process it
   *                (respond / relay / act) WITHOUT a user query.
   *  - patrol:     on-message + a periodic self-check every `patrolIntervalMin`.
   *  - always:     on-message + change-driven wake (blackboard/subtask deltas) +
   *                a heartbeat self-check every `alwaysCooldownMin`.
   */
  autonomy?: {
    mode: "off" | "on-message" | "patrol" | "always";
    patrolIntervalMin?: number;
    alwaysCooldownMin?: number;
  };
}

/** Which instance this session belongs to (null = ungrouped). */
export interface Membership {
  groupId: string;
  role: GroupRole;
  name: string;
}

export function groupsDir(): string {
  return dataPath("groups");
}

// ---- low-level read/write ----------------------------------------------------

function groupPath(id: string): string {
  return join(groupsDir(), id, "group.yaml");
}

function readGroup(id: string): AgentGroup | null {
  if (!GROUP_ID_RE.test(id)) return null;
  try {
    const raw = readFileSync(groupPath(id), "utf-8");
    const g = yaml.load(raw) as AgentGroup;
    if (!g || typeof g.id !== "string" || !Array.isArray(g.members)) return null;
    return g;
  } catch { return null; }
}

/** Atomic write (tmp + rename) — same pattern as Blackboard.write. */
function writeGroup(g: AgentGroup): void {
  try {
    mkdirSync(join(groupsDir(), g.id), { recursive: true });
    const tmp = `${groupPath(g.id)}.tmp`;
    writeFileSync(tmp, yaml.dump(g, { indent: 2, lineWidth: 120 }), "utf-8");
    renameSync(tmp, groupPath(g.id));
  } catch { /* best-effort; callers validate input first */ }
}

/** Normalize a display name into a group-id slug (kept inside GROUP_ID_RE). */
function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^0-9a-z_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "group";
}

// ---- public API ---------------------------------------------------------------

export function listGroups(): AgentGroup[] {
  try {
    const dir = groupsDir();
    let ids: string[] = [];
    try { ids = readdirSync(dir); } catch { return []; }
    const out: AgentGroup[] = [];
    for (const id of ids) {
      if (!existsSync(groupPath(id))) continue;
      const g = readGroup(id);
      if (g) out.push(g);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  } catch { return []; }
}

export function getGroup(id: string): AgentGroup | null {
  return readGroup(id);
}

/** The lead's purpose text — inline description, or the first 300 chars of the file. */
export function groupPurpose(g: AgentGroup): string {
  if (g.description) return g.description;
  if (g.descriptionPath) {
    try {
      const raw = readFileSync(g.descriptionPath, "utf-8");
      return raw.trim().slice(0, 300);
    } catch { return "(描述文件不可读)"; }
  }
  return "";
}

/**
 * Create a group. 基础配置先行 (mandatory): name + at least one of description /
 * descriptionFile. A descriptionFile is written to <groupId>/description.md and
 * becomes the lead's job definition (injected into its Group Context).
 */
export function createGroup(input: {
  name: string;
  description?: string;
  descriptionFile?: { filename: string; content: string };
  /** Cross-group policy toggles (base config) — default false = isolated. */
  allowViewOthers?: boolean;
  allowMessageOthers?: boolean;
}): AgentGroup {
  const name = (input.name || "").trim();
  const description = (input.description || "").trim();
  if (!name) throw new Error("createGroup: group name is required");
  if (!description && !input.descriptionFile) {
    throw new Error("createGroup: a role/responsibility description (description or descriptionFile) is required");
  }

  // Unique id: g-<slug>-<4 hex>, collision-checked against disk.
  let id = "";
  for (let i = 0; i < 16; i++) {
    const candidate = `g-${slugify(name)}-${randomBytes(2).toString("hex")}`;
    if (!existsSync(groupPath(candidate))) { id = candidate; break; }
  }
  if (!id) throw new Error("createGroup: could not allocate a unique group id");

  let descriptionPath = "";
  if (input.descriptionFile) {
    descriptionPath = join(groupsDir(), id, "description.md");
  }

  const now = new Date().toISOString();
  const g: AgentGroup = {
    id,
    name,
    description: description ? description : undefined,
    descriptionPath: descriptionPath || undefined,
    members: [],
    createdAt: now,
    updatedAt: now,
    allowViewOthers: input.allowViewOthers ?? false,
    allowMessageOthers: input.allowMessageOthers ?? false,
  };

  writeGroup(g);
  if (input.descriptionFile) {
    try {
      mkdirSync(join(groupsDir(), id), { recursive: true });
      const tmp = `${descriptionPath}.tmp`;
      writeFileSync(tmp, input.descriptionFile.content, "utf-8");
      renameSync(tmp, descriptionPath);
    } catch { /* best-effort file write */ }
  }
  return readGroup(id) ?? g;
}

export function deleteGroup(id: string): boolean {
  if (!GROUP_ID_RE.test(id)) return false;
  try {
    unlinkSync(groupPath(id));
    return true;
  } catch { return false; }
}

function touch(g: AgentGroup): AgentGroup {
  g.updatedAt = new Date().toISOString();
  writeGroup(g);
  return readGroup(g.id) ?? g;
}

/**
 * Add a member. Invariants:
 *  - one instance belongs to at most one group (rejected otherwise);
 *  - the first member added to an empty group becomes the lead;
 *  - adding a second lead demotes the previous one.
 */
export function addMember(
  id: string,
  m: { sessionId: string; role: GroupRole; name: string },
): AgentGroup | null {
  const g = readGroup(id);
  if (!g) return null;
  const sessionId = (m.sessionId || "").trim();
  if (!SESSION_ID_RE.test(sessionId)) return null;
  if (g.members.some((x) => x.sessionId === sessionId)) return g; // already a member — no-op

  // One instance, one group.
  for (const other of listGroups()) {
    if (other.id === id) continue;
    if (other.members.some((x) => x.sessionId === sessionId)) return null;
  }

  const role: GroupRole = g.members.length === 0 ? "lead" : (m.role === "lead" ? "lead" : "member");
  if (role === "lead") {
    // Single-lead invariant: demote any existing lead.
    for (const mem of g.members) if (mem.role === "lead") mem.role = "member";
  }
  g.members.push({ sessionId, role, name: (m.name || sessionId.slice(0, 8)).trim() });
  return touch(g);
}

export function removeMember(id: string, sessionId: string): AgentGroup | null {
  const g = readGroup(id);
  if (!g) return null;
  const idx = g.members.findIndex((x) => x.sessionId === sessionId);
  if (idx < 0) return g;
  g.members.splice(idx, 1);
  // If we removed the lead and members remain, promote the first one (single-lead).
  if (g.members.length > 0 && !g.members.some((x) => x.role === "lead")) {
    g.members[0].role = "lead";
  }
  return touch(g);
}

/**
 * Rotate a member's sessionId in place (old → new), preserving role/name.
 * Used to heal a drifted roster: an engine whose sessionId changed still belongs
 * to the group, so the old key is swapped for the new one in a SINGLE atomic
 * write (no racy remove+add). Returns null if the old key isn't found, the ids
 * are invalid, or the new id already belongs to another group.
 */
export function rotateMemberSession(id: string, oldSid: string, newSid: string): AgentGroup | null {
  if (!SESSION_ID_RE.test(oldSid) || !SESSION_ID_RE.test(newSid)) return null;
  const g = readGroup(id);
  if (!g) return null;
  const idx = g.members.findIndex((x) => x.sessionId === oldSid);
  if (idx < 0) return null;
  if (g.members.some((x) => x.sessionId === newSid)) return g; // already up to date — no-op
  for (const other of listGroups()) {
    if (other.id === id) continue;
    if (other.members.some((x) => x.sessionId === newSid)) return null;
  }
  g.members[idx].sessionId = newSid;
  return touch(g);
}

/** Rename a member in place (used by the desktop rename action). Rejects a
 *  name already taken by another member of the SAME group — cross-group
 *  duplicates are allowed (each group numbers itself from Agent 1). */
export function renameMember(id: string, sessionId: string, newName: string): AgentGroup | null {
  const g = readGroup(id);
  if (!g) return null;
  const mem = g.members.find((x) => x.sessionId === sessionId);
  if (!mem) return null;
  const name = (newName || "").trim();
  if (!name || name.length > 40) return null;
  if (g.members.some((x) => x.sessionId !== sessionId && x.name === name)) return null;
  mem.name = name;
  return touch(g);
}

/** Promote a member to lead (demoting the current lead). */
export function setLead(id: string, sessionId: string): AgentGroup | null {
  const g = readGroup(id);
  if (!g) return null;
  const target = g.members.find((x) => x.sessionId === sessionId);
  if (!target) return null;
  for (const mem of g.members) mem.role = mem.sessionId === sessionId ? "lead" : "member";
  return touch(g);
}

/** Cross-group policy for a group — undefined fields are left unchanged. */
export function setGroupPolicy(
  id: string,
  patch: { allowViewOthers?: boolean; allowMessageOthers?: boolean },
): AgentGroup | null {
  const g = readGroup(id);
  if (!g) return null;
  if (typeof patch.allowViewOthers === "boolean") g.allowViewOthers = patch.allowViewOthers;
  if (typeof patch.allowMessageOthers === "boolean") g.allowMessageOthers = patch.allowMessageOthers;
  return touch(g);
}

/** Cross-group policy with legacy groups defaulting to isolated (false). */
export function groupPolicy(g: AgentGroup): { allowViewOthers: boolean; allowMessageOthers: boolean } {
  return {
    allowViewOthers: g.allowViewOthers ?? false,
    allowMessageOthers: g.allowMessageOthers ?? false,
  };
}

/** Per-group autonomy policy — undefined fields are left unchanged. */
export function setGroupAutonomy(
  id: string,
  patch: { mode?: "off" | "on-message" | "patrol" | "always"; patrolIntervalMin?: number; alwaysCooldownMin?: number },
): AgentGroup | null {
  const g = readGroup(id);
  if (!g) return null;
  const cur = groupAutonomy(g);
  if (patch.mode) cur.mode = patch.mode;
  if (typeof patch.patrolIntervalMin === "number" && patch.patrolIntervalMin > 0) cur.patrolIntervalMin = patch.patrolIntervalMin;
  if (typeof patch.alwaysCooldownMin === "number" && patch.alwaysCooldownMin > 0) cur.alwaysCooldownMin = patch.alwaysCooldownMin;
  g.autonomy = cur;
  return touch(g);
}

/** Autonomy policy with legacy groups defaulting to off (current behavior). */
export function groupAutonomy(g: AgentGroup): { mode: "off" | "on-message" | "patrol" | "always"; patrolIntervalMin: number; alwaysCooldownMin: number } {
  const a = g.autonomy;
  if (!a || !a.mode) return { mode: "off", patrolIntervalMin: 30, alwaysCooldownMin: 15 };
  return {
    mode: a.mode,
    patrolIntervalMin: a.patrolIntervalMin ?? 30,
    alwaysCooldownMin: a.alwaysCooldownMin ?? 15,
  };
}

/** The group a session belongs to, or null if ungrouped. */
export function getMembershipBySessionId(sessionId: string): Membership | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  for (const g of listGroups()) {
    for (const mem of g.members) {
      if (mem.sessionId === sessionId) {
        return { groupId: g.id, role: mem.role, name: mem.name };
      }
    }
  }
  return null;
}

// ---- cross-group gate predicate ------------------------------------------------

/** ask/send_message (both namespace aliases) whose execution is gated on the target's group. */
export const CROSS_GROUP_TOOLS: ReadonlySet<string> = new Set([
  "ouroboros:ask",
  "claude-code:ask",
  "ouroboros:send_message",
  "claude-code:send_message",
]);

/**
 * Pure predicate: should a cross-group permission prompt gate this call?
 *  - ungrouped sender → false (legacy multi-open, no gate)
 *  - not ask/send_message → false (static dangerous rules apply)
 *  - target in a different group, OR target ungrouped (external contact) → true
 */
export function isCrossGroupToolCall(
  fqn: string,
  args: Record<string, unknown>,
  myGroup: Membership | null,
): boolean {
  if (!myGroup) return false;
  if (!CROSS_GROUP_TOOLS.has(fqn)) return false;
  const target = String(args?.target ?? "").trim();
  if (!target) return false;
  const t = getMembershipBySessionId(target);
  return !t || t.groupId !== myGroup.groupId;
}
