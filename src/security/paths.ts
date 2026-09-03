// =============================================================================
// Workspace path constraints (P1)
// Tool-level enforcement of "only write inside the workspace". The prompt alone
// is not enough — models forget it mid-task — so write/edit/mkdir/rm tools gate
// paths through here, and out-of-workspace writes trigger a permission prompt.
// =============================================================================

import { resolve, join, normalize } from "node:path";
import { homedir } from "node:os";

export interface SecurityPathsConfig {
  workspaceRoot?: string;
  allowedWritePaths?: string[];
}

let config: SecurityPathsConfig = {};

/** Called once at startup with the merged security config (see config/defaults.ts). */
export function setSecurityPathsConfig(cfg: SecurityPathsConfig): void {
  config = cfg ?? {};
}

/** Workspace root — config `security.workspaceRoot` ?? cwd. */
export function getWorkspaceRoot(): string {
  return resolve(config.workspaceRoot || process.cwd());
}

/** Normalize for comparison: absolute, forward slashes, case-folded (Windows-safe). */
function norm(p: string): string {
  let expanded = p.trim();
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(homedir(), expanded.slice(2));
  }
  return resolve(expanded).replace(/[\\/]+/g, "/").toLowerCase();
}

/** True if `path` equals the workspace root or lives underneath it. */
export function isInsideWorkspace(path: string): boolean {
  const root = norm(getWorkspaceRoot());
  const target = norm(path);
  return target === root || target.startsWith(root + "/");
}

/** True if `path` matches one of config `security.allowedWritePaths` (prefix match). */
export function isAllowedOutsideWrite(path: string): boolean {
  const target = norm(path);
  for (const allowed of config.allowedWritePaths ?? []) {
    const a = norm(allowed);
    if (target === a || target.startsWith(a + "/")) return true;
  }
  return false;
}

// System paths that are never writable by the agent regardless of workspace config.
const SYSTEM_WRITE_BLOCKS: Array<{ prefix: string; reason: string }> = [
  { prefix: "/windows/system32", reason: "system directory" },
  { prefix: "/windows/system", reason: "system directory" },
  { prefix: "/program files", reason: "program files" },
  { prefix: "/program files (x86)", reason: "program files" },
  { prefix: "/etc", reason: "system config" },
  { prefix: "/usr", reason: "system directory" },
  { prefix: "/bin", reason: "system directory" },
  { prefix: "/sbin", reason: "system directory" },
  { prefix: "/boot", reason: "system directory" },
  { prefix: "/dev", reason: "system device" },
  { prefix: "/proc", reason: "system device" },
  { prefix: "/sys", reason: "system device" },
  { prefix: "/var", reason: "system directory" },
];

/** Hard system-path block: returns a reason string, or null if the path is not system-protected. */
export function isSystemWriteBlocked(path: string): string | null {
  const target = norm(path);
  // Windows: "c:/windows/system32/..." → "/windows/system32/..." so the
  // drive-agnostic prefixes below match. No false positives: only paths at the
  // drive root (real system dirs) drop their drive letter this way.
  const targetNoDrive = target.replace(/^[a-z]:/, "");
  for (const { prefix, reason } of SYSTEM_WRITE_BLOCKS) {
    if (target === prefix || target.startsWith(prefix + "/")) {
      return reason;
    }
    if (targetNoDrive === prefix || targetNoDrive.startsWith(prefix + "/")) {
      return reason;
    }
  }
  return null;
}

/** Full writability check: system path + workspace containment. */
export function assertWritable(path: string): { ok: true } | { ok: false; reason: string } {
  const sys = isSystemWriteBlocked(path);
  if (sys) return { ok: false, reason: `Write to ${sys} is not allowed: ${path}` };

  if (isInsideWorkspace(path) || isAllowedOutsideWrite(path)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `Path is outside the workspace (${getWorkspaceRoot()}) and not in security.allowedWritePaths: ${path}`,
  };
}

/** Cross-platform test hook (unit tests). */
export function _resetSecurityPathsConfigForTest(): void {
  config = {};
}
