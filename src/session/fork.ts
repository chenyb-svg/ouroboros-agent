// =============================================================================
// Fork — Create a new session from current state (Phase 4)
// =============================================================================

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { initSession, generateSessionId } from "./lifecycle.js";
import type { FormattedMessage } from "../types/messages.js";
import type { OuroborosConfig } from "../types/config.js";
import type { TerminalCapabilities } from "../terminal/detector.js";

export interface ForkResult {
  newSessionId: string;
  messageCount: number;
  path: string;
}

/**
 * Fork the current session. Creates a new session with:
 * - Deep-copied messages (optionally truncated)
 * - Copied shared state
 * - Fresh budget
 * - Same memory layer access
 * - New session ID + fresh permissions
 */
export function forkSession(
  config: OuroborosConfig,
  caps: TerminalCapabilities,
  workDir: string,
  messages: FormattedMessage[],
  sharedState: Record<string, unknown>,
): ForkResult {
  const newSession = initSession(config, caps, workDir);
  const newSessionId = newSession.meta.sessionId;

  // Deep copy messages
  const copiedMessages = JSON.parse(JSON.stringify(messages)) as FormattedMessage[];

  // Inject fork marker
  copiedMessages.unshift({
    role: "system",
    content: `[Forked from session. Shared state and memory preserved. Budget reset.]`,
  });

  // Copy shared state
  const copiedState = JSON.parse(JSON.stringify(sharedState));

  // Write initial state files
  writeFileSync(
    join(newSession.paths.sessionDir, "fork_messages.json"),
    JSON.stringify(copiedMessages, null, 2),
    "utf-8",
  );
  writeFileSync(
    join(newSession.paths.sessionDir, "fork_shared_state.json"),
    JSON.stringify(copiedState, null, 2),
    "utf-8",
  );

  return {
    newSessionId,
    messageCount: copiedMessages.length,
    path: newSession.paths.sessionDir,
  };
}
