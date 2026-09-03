// =============================================================================
// File Lock — cross-process mutual exclusion via O_EXCL lock files
// Used by memory/history flush so two Ouroboros instances sharing a cwd don't
// clobber each other's JSONL rewrites.
// =============================================================================

import { openSync, closeSync, unlinkSync, statSync } from "node:fs";

/** Synchronous sleep (Node has no sync sleep — Atomics.wait blocks the thread). */
function syncSleep(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* Atomics unavailable — fall through */ }
}

export interface FileLockOptions {
  /** A lock file older than this (ms) is treated as stale and broken. */
  ttlMs?: number;
  /** Max acquisition attempts before giving up and running unlocked. */
  retries?: number;
  /** Delay between attempts (ms). */
  retryDelayMs?: number;
}

/**
 * Run `fn` while holding an exclusive cross-process lock on `path`.
 * Acquisition is atomic (O_EXCL create of `<path>.lock`); a lock older than
 * `ttlMs` is broken as stale. If the lock can't be acquired within the retry
 * budget, `fn` still runs (best-effort) — the locking layer never throws into
 * application code. The caller is responsible for its own error handling.
 */
export function withFileLock<T>(path: string, fn: () => T, opts: FileLockOptions = {}): T {
  const ttlMs = opts.ttlMs ?? 10_000;
  const retries = opts.retries ?? 20;
  const retryDelayMs = opts.retryDelayMs ?? 25;
  const lockPath = `${path}.lock`;

  let fd: number | null = null;
  const acquire = (): boolean => {
    if (fd !== null) return true;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        fd = openSync(lockPath, "wx");
        return true;
      } catch (err: any) {
        if (err.code !== "EEXIST") return false; // e.g. permission denied — give up gracefully
        // Stale check: break locks older than ttlMs
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs > ttlMs) {
            unlinkSync(lockPath);
            continue; // retry acquire immediately
          }
        } catch {
          // Lock vanished between stat and unlink — treat as free, retry
          continue;
        }
        if (attempt >= retries) return false;
        syncSleep(retryDelayMs);
      }
    }
    return false;
  };

  try {
    acquire();
    return fn();
  } finally {
    if (fd !== null) {
      // Close first — Windows can't unlink an open file. Both steps are sync,
      // so the release window is a few microseconds at most.
      try { closeSync(fd); } catch {}
      try { unlinkSync(lockPath); } catch {}
    }
  }
}
