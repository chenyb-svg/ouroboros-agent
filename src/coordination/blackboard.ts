// =============================================================================
// Blackboard — cross-instance status sharing via the filesystem
// Every running Ouroboros writes ~/.ouroboros/instances/<sessionId>.json so
// other instances know who is alive, what they're working on, and where they
// are (device field keeps the format forward-compatible with the Jarvis-style
// star topology: phones / glasses / hub agents all register the same shape).
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { dataPath } from "../data-home.js";
import { createHash } from "node:crypto";

export type InstanceState = "idle" | "reasoning" | "exited";

export interface ActiveSubtask { ticketId: string; task: string }

export interface InstanceInfo {
  version: 1;
  sessionId: string;
  name: string;
  device: string;
  pid: number;
  state: InstanceState;
  currentTask?: string;
  /** Most recent completed task (input text) — survives idle so others know what we did. */
  lastTask?: string;
  /** Short summary of the last completed response — survives idle. */
  lastResult?: string;
  activeSubtasks: ActiveSubtask[];
  skills: string[];
  model: string;
  ports: { wechat?: number };
  cwd: string;
  startedAt: number;
  heartbeat: number;
  /** Agent-group membership (see coordination/groups.ts) — optional, backward compatible. */
  groupId?: string;
  role?: "lead" | "member";
}

/** Static identity supplied by setExtras (model/skills change rarely). */
export interface InstanceExtras {
  skills: string[];
  model: string;
}

const STALE_MS = 90_000;         // no heartbeat for 90s → dead, prune
const EXITED_GRACE_MS = 5 * 60_000; // exited + 5min → delete

export class Blackboard {
  private path: string;
  private dir: string;
  private sessionId: string;
  private extras: InstanceExtras = { skills: [], model: "" };
  private cached: InstanceInfo | null;
  private lastWriteDigest = "";

  /** rootDir overrides ~/.ouroboros/instances — used by tests to isolate to a temp dir. */
  constructor(sessionId: string, init: { name: string; device: string }, rootDir?: string) {
    this.sessionId = sessionId;
    this.dir = rootDir ?? dataPath("instances");
    try { mkdirSync(this.dir, { recursive: true }); } catch { /* best-effort */ }
    this.path = join(this.dir, `${sessionId}.json`);
    this.cached = {
      version: 1,
      sessionId,
      name: init.name,
      device: init.device,
      pid: process.pid,
      state: "idle",
      activeSubtasks: [],
      skills: [],
      model: "",
      ports: {},
      cwd: process.cwd(),
      startedAt: Date.now(),
      heartbeat: Date.now(),
    };
  }

  setExtras(extras: Partial<InstanceExtras>): void {
    this.extras = { ...this.extras, ...extras };
    // Write through — the record must reflect latest model/skills even when
    // setExtras is called after register (e.g. skills published post-boot).
    if (this.cached) this.sync({});
  }

  /**
   * Merge a patch into the local record and persist if anything changed.
   * Digest-throttled so a no-op sync doesn't rewrite the file on every call.
   * Never throws.
   */
  sync(patch: Partial<InstanceInfo>): void {
    if (!this.cached) return;
    const merged: InstanceInfo = {
      ...this.cached,
      ...patch,
      sessionId: this.sessionId,
      heartbeat: Date.now(),
      // extras are the source of truth for the slow-changing identity fields
      skills: this.extras.skills ?? [],
      model: this.extras.model ?? "",
    };
    merged.activeSubtasks = merged.activeSubtasks ?? [];
    merged.ports = merged.ports ?? {};
    const digest = createHash("md5").update(JSON.stringify(merged)).digest("hex");
    if (digest === this.lastWriteDigest) return;
    this.cached = merged;
    this.lastWriteDigest = digest;
    this.write();
  }

  /** Heartbeat only — keeps the instance alive without rewriting state. */
  touch(): void {
    if (!this.cached) return;
    this.cached.heartbeat = Date.now();
    this.write();
  }

  /** Publish the record with ports once servers have bound (called at boot). */
  register(ports: { wechat?: number } = {}): void {
    if (!this.cached) return;
    this.cached = { ...this.cached, ports, skills: this.extras.skills ?? [], model: this.extras.model ?? "" };
    this.lastWriteDigest = "";
    this.sync({});
  }

  markExited(): void {
    this.sync({ state: "exited" });
  }

  /** This instance's own record (read-only copy). */
  me(): InstanceInfo | null {
    return this.cached ? { ...this.cached } : null;
  }

  /** Other instances' records (excludes self), pruning stale/exited ones. */
  list(): InstanceInfo[] {
    const dir = this.dir;
    const out: InstanceInfo[] = [];
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return out; }
    const now = Date.now();
    for (const f of files) {
      const id = f.slice(0, -5);
      if (id === this.sessionId) continue;
      let info: InstanceInfo;
      try {
        info = JSON.parse(readFileSync(join(dir, f), "utf-8")) as InstanceInfo;
      } catch { continue; } // corrupt/partial write — skip
      if (!info || !info.sessionId) continue;
      const age = now - (info.heartbeat || 0);
      if (info.state === "exited") {
        if (age > EXITED_GRACE_MS) { try { unlinkSync(join(dir, f)); } catch {} continue; }
      } else if (age > STALE_MS) {
        try { unlinkSync(join(dir, f)); } catch {} continue;
      }
      out.push(info);
    }
    return out;
  }

  private write(): void {
    if (!this.cached) return;
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.cached, null, 2), "utf-8");
      renameSync(tmp, this.path); // atomic replace
    } catch { /* never throw */ }
  }
}
