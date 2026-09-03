// =============================================================================
// Ouroboros Session Lifecycle — Session ID generation, directory creation
// =============================================================================

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionMeta, SessionPaths, SessionState } from "../types/session.js";
import type { OuroborosConfig } from "../types/config.js";
import type { TerminalCapabilities } from "../terminal/detector.js";

/**
 * Generate a human-readable, lexicographically sortable session ID.
 * Format: YYYYMMDD-HHmmss-{4 hex chars}
 */
export function generateSessionId(): string {
  const now = new Date();
  const datePart = [
    now.getFullYear().toString(),
    (now.getMonth() + 1).toString().padStart(2, "0"),
    now.getDate().toString().padStart(2, "0"),
  ].join("");

  const timePart = [
    now.getHours().toString().padStart(2, "0"),
    now.getMinutes().toString().padStart(2, "0"),
    now.getSeconds().toString().padStart(2, "0"),
  ].join("");

  const entropy = randomBytes(2).toString("hex"); // 4 hex chars

  return `${datePart}-${timePart}-${entropy}`;
}

/**
 * Get the short display form of a session ID (first 8 chars).
 */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * Initialize a new session: create directories, write metadata.
 */
export function initSession(
  config: OuroborosConfig,
  caps: TerminalCapabilities,
  workDir: string,
): SessionState {
  const sessionsDir = config.storage.sessionsDir.replace(/^~/, () => homedir());

  // Pinned identity: the desktop sets OUROBOROS_SESSION_ID when relaunching an
  // EXISTING agent (role / name / config restarts, ghost restart). Reusing the id
  // keeps group rosters (keyed by sessionId) valid across restarts — otherwise
  // every restart rotates the key and the member silently drifts out of its
  // group. A plain `resume <id>` (session-list) does NOT set this env, so it
  // keeps its documented semantic: load the history into a fresh session.
  const pinned = process.env.OUROBOROS_SESSION_ID?.trim() || "";
  let sessionId: string;
  if (pinned) {
    sessionId = pinned;
  } else {
    // Two instances starting in the same second must not share a session dir
    // (that would interleave transcripts and corrupt both sessions).
    sessionId = generateSessionId();
    while (existsSync(join(sessionsDir, sessionId))) sessionId = generateSessionId();
  }

  const sessionDir = join(sessionsDir, sessionId);
  const sidechainsDir = join(sessionDir, "sidechains");

  // Create directories
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(sidechainsDir, { recursive: true });

  const paths: SessionPaths = {
    sessionDir,
    transcriptPath: join(sessionDir, "transcript.jsonl"),
    metaPath: join(sessionDir, "meta.json"),
    sidechainsDir,
  };

  // When re-pinning an existing session, keep its original createdAt instead of
  // clobbering it — this is the SAME session being relaunched, not a new one.
  let createdAt = new Date().toISOString();
  if (pinned) {
    try {
      const existing = JSON.parse(readFileSync(paths.metaPath, "utf-8")) as SessionMeta;
      if (existing && typeof existing.createdAt === "string") createdAt = existing.createdAt;
    } catch { /* no prior meta — fresh pin */ }
  }

  const meta: SessionMeta = {
    sessionId,
    createdAt,
    workDir,
    configSnapshot: JSON.parse(JSON.stringify(config)),
    terminalWidth: caps.width,
    terminalHeight: caps.height,
    isTTY: caps.isTTY,
    colorLevel: caps.colorLevel === "truecolor" ? 24 : caps.colorLevel,
  };

  // Re-pinning an existing session: preserve the durable fields that later boot
  // steps write (desktop owner identity, persisted token spend, conversation
  // title). Without this, a relaunch would wipe them — exactly the kind of
  // "agent-carried info silently lost on restart" the three-tier model forbids.
  if (pinned) {
    try {
      const existing = JSON.parse(readFileSync(paths.metaPath, "utf-8")) as Partial<SessionMeta>;
      if (existing && typeof existing === "object") {
        if (existing.owner !== undefined) meta.owner = existing.owner;
        if (existing.usage !== undefined) meta.usage = existing.usage;
        if (existing.title !== undefined) meta.title = existing.title;
        // The durable role copy — re-pinning (restart) must not wipe it.
        if (existing.role !== undefined) meta.role = existing.role;
      }
    } catch { /* no prior meta — fresh pin */ }
  }

  // Write metadata
  writeFileSync(paths.metaPath, JSON.stringify(meta, null, 2), "utf-8");

  return {
    meta,
    paths,
    transcriptLineCount: 0,
    startedAt: performance.now(),
    endedAt: null,
  };
}

/**
 * Finalize session: write end metadata, return summary.
 */
export function finalizeSession(state: SessionState): SessionState {
  state.endedAt = performance.now();
  const meta = { ...state.meta, endedAt: new Date().toISOString() };
  writeFileSync(state.paths.metaPath, JSON.stringify(meta, null, 2), "utf-8");
  return { ...state, meta };
}
