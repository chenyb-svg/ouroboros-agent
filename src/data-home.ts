// =============================================================================
// src/data-home.ts — canonical location for all Ouroboros user state.
//
// Default:  ~/.ouroboros  (OS-standard user data dir, portable across machines
//           and drive letters — never hardcode a specific disk).
// Override: OUROBOROS_DATA_HOME env var relocates the data root, e.g. point it
//           at a large secondary drive when the OS drive is small. Same pattern
//           as XDG_DATA_HOME / npm_config_cache / PIP_CACHE_DIR.
//
// Both the CLI and every desktop engine child MUST resolve the same root here —
// cross-process coordination (blackboard/inbox, file locks) lives under it, so
// a split would silently break multi-instance cooperation. Project-level state
// (<project>/.ouroboros) is intentionally NOT covered by this override.
// =============================================================================

import { homedir } from "node:os";
import { join } from "node:path";

/** Root of all user state (sessions, memory, instances, permissions, config, …). */
export function dataHome(): string {
  return process.env.OUROBOROS_DATA_HOME || join(homedir(), ".ouroboros");
}

/** Resolve a path under the data root, e.g. dataPath("sessions", sessionId). */
export function dataPath(...parts: string[]): string {
  return join(dataHome(), ...parts);
}
