// =============================================================================
// Ouroboros Session — Lifecycle & transcript types
// =============================================================================

export interface SessionMeta {
  sessionId: string;
  createdAt: string;          // ISO 8601
  workDir: string;
  configSnapshot: Record<string, unknown>;
  terminalWidth: number;
  terminalHeight: number;
  isTTY: boolean;
  colorLevel: number;
  /** Desktop agent that owns this session (agentId + its display name), stamped
   *  from OUROBOROS_AGENT_ID / OUROBOROS_INSTANCE_NAME. Lets the desktop session
   *  list label a session by identity even when the owning agent is closed.
   *  Plain CLI / `resume` sessions leave this unset. */
  owner?: { agentId: string; name: string } | null;
  /** Persisted per-session token spend (cumulative + last) — appended after each
   *  completed LLM turn so the desktop budget dashboard survives restarts. */
  usage?: { cumulative: TokenUsage | null; last: TokenUsage | null } | null;
  /** Conversation title — stamped from the first user message. */
  title?: string;
  /** Desktop-owner custom role (persona override) — stamped from OUROBOROS_ROLE at
   *  boot. A DURABLE SECOND COPY of the agent's role (which otherwise lives only in
   *  the desktop's agents.json): restore() backfills the roster from it and the
   *  engine's persona falls back to it, so a roster wipe can never take the role
   *  with it. Empty string = explicitly cleared; absent = never set. */
  role?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TranscriptEntry {
  line: number;
  event: Record<string, unknown>; // full event object, serialized
  writtenAt: string;             // ISO 8601
}

export interface SessionPaths {
  sessionDir: string;
  transcriptPath: string;
  metaPath: string;
  sidechainsDir: string;
}

export interface SessionState {
  meta: SessionMeta;
  paths: SessionPaths;
  transcriptLineCount: number;
  startedAt: number;   // performance.now()
  endedAt: number | null;
}
