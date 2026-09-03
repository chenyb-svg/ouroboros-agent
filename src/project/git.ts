// =============================================================================
// Git Integration — Status, diff, auto-commit (Phase 4)
//
// Every git command here runs through the shell-harness (src/tools/shell-harness):
// the absolute git.exe (registry-backed when PATH lacks Git\cmd under a
// shortcut/package launch), a known-good PATH, and an explicitly resolved
// cmd.exe. WITHOUT that, a stripped PATH makes `git` un-resolvable, and the
// old code's catch blocks collapsed the resulting "git is not recognized"
// error into "(not a git repository)" — the Git panel showed a misleading
// "当前目录不是 Git 仓库" even when the directory really WAS a repo.
// =============================================================================

import { execSync } from "node:child_process";
import { buildShellEnv, cmdExe, gitExePath } from "../tools/shell-harness.js";

/** Absolute git.exe when discoverable (registry-backed), else `git` by name. */
function gitExe(): string {
  const exe = gitExePath();
  return exe ? `"${exe}"` : "git";
}

/** Run git with the shell-harness environment + explicit cmd.exe, so it works
 *  under a stripped PATH and never resolves the WSL shim. */
function gitRun(args: string, cwd: string, timeout = 5000): string {
  return execSync(`${gitExe()} ${args}`, {
    cwd,
    encoding: "utf-8",
    timeout,
    shell: cmdExe(),
    env: buildShellEnv(),
    // Without explicit stdio, cmd.exe (the shell) inherits the parent console and
    // git's stderr on a FAILED probe (e.g. "fatal: not a git repository") leaks to
    // stdout even though execSync captures it — spam in the engine log. Piping it
    // explicitly keeps stderr inside the thrown error.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Run a git command, retrying transient index.lock contention. Multiple engines
 *  (and the desktop's hidden system engine) share one repo root, so concurrent
 *  add/commit can collide on the lock file — a short retry makes them sequential. */
function gitRunRetry(args: string, cwd: string, timeout = 10000, tries = 5): string {
  const sleep = (ms: number): void => {
    const end = Date.now() + ms;
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, end - Date.now());
  };
  for (let i = 0; i < tries; i++) {
    try {
      return gitRun(args, cwd, timeout);
    } catch (e: any) {
      const msg = String(e?.stderr || e?.message || "");
      if (msg.includes("index.lock") || msg.includes("Unable to create")) {
        sleep(250 * (i + 1));
        continue;
      }
      throw e;
    }
  }
  throw new Error("git lock retry exhausted");
}

export class GitIntegration {
  private workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  /** Get short git status */
  getStatus(): string {
    try {
      return gitRun("status --short", this.workDir).trim() || "(clean)";
    } catch {
      return "(not a git repository)";
    }
  }

  /** Get diff stat overview */
  getDiffStat(): string {
    try {
      return gitRun("diff --stat", this.workDir).trim() || "(no changes)";
    } catch {
      return "(not available)";
    }
  }

  /** Get current branch name */
  getBranch(): string {
    try {
      return gitRun("branch --show-current", this.workDir, 3000).trim() || "unknown";
    } catch {
      return "unknown";
    }
  }

  /** Get recent commit messages */
  getRecentCommits(count: number = 3): string[] {
    try {
      const output = gitRun(`log --oneline -${count} --format="%s"`, this.workDir, 3000).trim();
      return output.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Colored working-tree diff (truncated) for terminal display */
  getDiff(maxLines: number = 60): string {
    try {
      const raw = gitRun("diff", this.workDir).trim();
      if (!raw) return "(no changes)";
      const lines = raw.split("\n");
      const out: string[] = [];
      for (const l of lines) {
        if (l.startsWith("+") && !l.startsWith("+++")) out.push(`\x1b[32m${l.slice(0, 100)}\x1b[0m`);
        else if (l.startsWith("-") && !l.startsWith("---")) out.push(`\x1b[31m${l.slice(0, 100)}\x1b[0m`);
        else out.push(`\x1b[90m${l.slice(0, 100)}\x1b[0m`);
        if (out.length >= maxLines) { out.push(`… ${lines.length - out.length} more lines`); break; }
      }
      return out.join("\n");
    } catch {
      return "(not a git repository)";
    }
  }

  /** Auto-commit all changes with a checkpoint message */
  autoCommit(checkpointId: string): boolean {
    try {
      // Only commit if there are changes
      const status = gitRun("status --porcelain", this.workDir, 3000).trim();
      if (!status) return false; // Nothing to commit

      gitRun("add -A", this.workDir);
      gitRun(`commit -m "ouroboros checkpoint: ${checkpointId}"`, this.workDir);
      return true;
    } catch {
      return false;
    }
  }

  /** Get summary for context injection */
  getContextSummary(): string {
    const branch = this.getBranch();
    const status = this.getStatus().split("\n").slice(0, 10).join("\n");
    const commits = this.getRecentCommits(3);

    return [
      `Git branch: ${branch}`,
      `Recent commits: ${commits.join("; ") || "none"}`,
      `Status:\n${status}`,
    ].join("\n");
  }

  // ---- structured status (desktop Git panel) ---------------------------------

  /** True when workDir is a git repository (git rev-parse succeeds). */
  private isRepo(): boolean {
    try { gitRun("rev-parse --is-inside-work-tree", this.workDir, 3000); return true; }
    catch { return false; }
  }

  /** Per-file change stats from `git diff --numstat` (added\tdeleted\tpath). */
  private numstat(cached: boolean): Map<string, { additions: number; deletions: number }> {
    const out = new Map<string, { additions: number; deletions: number }>();
    try {
      const raw = gitRun(`diff ${cached ? "--cached " : ""}--numstat`, this.workDir).trim();
      for (const line of raw.split("\n").filter(Boolean)) {
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const path = parts.slice(2).join("\t").split(" -> ").pop()!; // renames → new path
        const add = parts[0] === "-" ? 0 : Number(parts[0]);
        const del = parts[1] === "-" ? 0 : Number(parts[1]);
        out.set(path, { additions: add || 0, deletions: del || 0 });
      }
    } catch { /* numstat unavailable (not a repo) — empty */ }
    return out;
  }

  /**
   * Structured status for the desktop panel: branch, porcelain file list with
   * staged/worktree flags + add/del counts, and the last 8 commits.
   *  - `gitAvailable:false` → git itself can't run (not installed / unresolvable);
   *    the panel shows an install hint instead of a misleading "not a repo".
   *  - `repo:false` + gitAvailable → workDir genuinely isn't a git repository;
   *    the panel offers "initialize here".
   */
  getStatusStructured(): {
    gitAvailable: boolean;
    repo: boolean;
    branch: string;
    files: Array<{ path: string; x: string; y: string; staged: boolean; worktree: boolean; additions: number; deletions: number }>;
    commits: Array<{ hash: string; subject: string; date: string }>;
  } {
    let usable = false;
    try { gitRun("--version", this.workDir, 3000); usable = true; } catch { /* git unavailable */ }
    if (!usable) return { gitAvailable: false, repo: false, branch: "", files: [], commits: [] };
    if (!this.isRepo()) return { gitAvailable: true, repo: false, branch: "", files: [], commits: [] };
    const branch = this.getBranch();
    const files: Array<{ path: string; x: string; y: string; staged: boolean; worktree: boolean; additions: number; deletions: number }> = [];
    try {
      const porcelain = gitRun("status --porcelain=v1 -z", this.workDir);
      const unstaged = this.numstat(false);
      const staged = this.numstat(true);
      for (const raw of porcelain.split("\0").filter(Boolean)) {
        if (raw.length < 3) continue;
        const x = raw[0];
        const y = raw[1];
        // Rename entries: "R  old -> new" — porcelain -z emits "R  new\0old" pairs.
        let path = raw.slice(3);
        // -z renames are two NUL-separated records; we only emit the new name.
        files.push({
          path,
          x,
          y,
          staged: x !== " " && x !== "?",
          worktree: y !== " " && y !== "?" && !(x === "?" && y === "?"),
          additions: (x !== " " && x !== "?" ? staged.get(path)?.additions : 0) ?? 0,
          deletions: (x !== " " && x !== "?" ? staged.get(path)?.deletions : 0) ?? 0,
        });
        const u = unstaged.get(path);
        if (u) {
          const f = files[files.length - 1];
          f.additions += u.additions;
          f.deletions += u.deletions;
        }
      }
    } catch { /* not a repo */ }
    const commits: Array<{ hash: string; subject: string; date: string }> = [];
    try {
      const log = gitRun('log -8 --format=%H%x09%s%x09%aI', this.workDir).trim();
      for (const line of log.split("\n").filter(Boolean)) {
        const [hash, subject, date] = line.split("\t");
        if (hash) commits.push({ hash: hash.slice(0, 8), subject: subject ?? "", date: date ?? "" });
      }
    } catch { /* no commits yet */ }
    return { gitAvailable: true, repo: true, branch, files, commits };
  }

  /** Raw unified diffs for one file: `{staged, worktree}` (each may be empty). */
  getFileDiff(path: string): { staged: string; worktree: string } {
    const run = (cached: boolean): string => {
      try {
        return gitRun(`diff ${cached ? "--cached " : ""}-- ${JSON.stringify(path)}`, this.workDir).trim();
      } catch { return ""; }
    };
    return { staged: run(true), worktree: run(false) };
  }

  /** Push local commits to the default remote (current branch's upstream). Push is
   *  network I/O, so no index.lock retry and a longer timeout than local commands.
   *  Common failure modes get a friendly hint; anything else passes the raw stderr
   *  through so the panel can surface it. */
  pushAll(): { ok: boolean; error?: string } {
    try {
      execSync(`${gitExe()} push`, { cwd: this.workDir, encoding: "utf-8", timeout: 60000, shell: cmdExe(), env: buildShellEnv(), stdio: ["ignore", "pipe", "pipe"] });
      return { ok: true };
    } catch (e: any) {
      const err = String(e?.stderr || e?.message || "");
      if (/no upstream|upstream branch/i.test(err))
        return { ok: false, error: "当前分支没有上游，先推送一次并设置上游：git push -u origin <branch>（no upstream — run git push -u origin <branch> first）" };
      if (/does not appear to be a git repository|No configured push destination|couldn't find remote ref/i.test(err))
        return { ok: false, error: "仓库未配置远程：git remote add origin <url>（no remote configured — run git remote add origin <url>）" };
      return { ok: false, error: err.slice(0, 300) };
    }
  }

  /** Stage everything and commit. Returns the new HEAD hash on success. */
  commitAll(message: string): { ok: boolean; hash?: string; error?: string } {
    const msg = String(message || "").trim();
    if (!msg) return { ok: false, error: "empty commit message" };
    try {
      gitRunRetry("add -A", this.workDir);
      gitRunRetry(`commit -m ${JSON.stringify(msg)}`, this.workDir);
      const hash = gitRun("rev-parse HEAD", this.workDir, 3000).trim().slice(0, 8);
      return { ok: true, hash };
    } catch (e: any) {
      const err = String(e?.stderr || e?.message || "");
      // Nothing to commit is not an error the user needs to see.
      if (err.includes("nothing to commit") || err.includes("no changes added")) return { ok: true, hash: undefined };
      return { ok: false, error: err.slice(0, 300) };
    }
  }

  /** `git init` in workDir — the panel's "not a repository" state offers this so
   *  a fresh folder becomes version-controlled without leaving the app. */
  initRepo(): { ok: boolean; error?: string } {
    try {
      gitRun("init", this.workDir);
      return { ok: true };
    } catch (e: any) {
      const err = String(e?.stderr || e?.message || "");
      return { ok: false, error: err.slice(0, 300) };
    }
  }
}
