// =============================================================================
// Shell harness — make the agent's shell-using tools (bash / grep / search /
// find / git / docker / notify) work in ANY environment, regardless of how the
// app was launched (terminal, Electron shortcut, packaged exe).
//
// Two problems this solves:
//   1. A minimal inherited PATH (Electron launched from a shortcut) can lack
//      `C:\Windows\System32` / `C:\Windows` — so `cmd.exe`, `chcp`, `taskkill`,
//      `powershell` silently don't resolve. We GUARANTEE those dirs are in every
//      shelled-out child's PATH.
//   2. cmd.exe is not bash. Claude Code runs commands through real Git Bash
//      (MSYS2) on Windows; that's the only way `$PWD`, `/c/...` paths, `&&`
//      pipes and the unix toolset (cp/grep/sed/awk) work. We resolve a real
//      bash.exe explicitly instead of trusting PATH, and fall back to cmd.exe.
//
// Zero business dependencies — only node builtins, so both the tool layer and
// the sandbox can import it without cycles.
// =============================================================================

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

let _cached: {
  unixToolsPath: string | null | undefined;
  bashPath: string | null | undefined;
  cmd: string | null | undefined;
  gitPath: string | null | undefined;
} = { unixToolsPath: undefined, bashPath: undefined, cmd: undefined, gitPath: undefined };

let _registryRoots: string[] | null = null;

/** Test hook: forget resolved paths so a later call re-scans (PATH may change). */
export function __resetShellHarnessCache(): void {
  _cached = { unixToolsPath: undefined, bashPath: undefined, cmd: undefined, gitPath: undefined };
  _registryRoots = null;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function existsFile(p: string): boolean {
  try { return existsSync(p); } catch { return false; }
}

/** Lowercase + strip quotes/trailing slashes — for case-insensitive PATH dedup. */
function normDir(p: string): string {
  return p.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "").toLowerCase();
}

/**
 * True when a directory is a Windows system dir (System32 / SysWOW64 / Sysnative /
 * the Windows root / WindowsApps). On Windows 11 with WSL enabled,
 * `%SystemRoot%\System32\bash.exe` is the WSL LAUNCHER SHIM (~86KB), not real
 * bash — it routes every shell command into WSL and fails with "WSL is
 * initializing" when no distro is installed. Real Git Bash is never installed
 * into these dirs, so any bash/git candidate that lives there is rejected.
 */
function isSystemDir(dir: string): boolean {
  const l = normDir(dir);
  if (!l) return false;
  const sysRoot = normDir(process.env.SystemRoot || process.env.WINDIR || "");
  if (sysRoot && l === sysRoot) return true;
  if (sysRoot) {
    for (const sub of ["system32", "syswow64", "sysnative"]) {
      const base = sysRoot + "\\" + sub;
      if (l === base || l.startsWith(base + "\\")) return true;
    }
  }
  const apps = normDir(join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps"));
  if (apps && (l === apps || l.startsWith(apps + "\\"))) return true;
  return false;
}

/**
 * Git-for-Windows install roots read from the registry (`InstallPath`). This is
 * the ONE source of truth that survives a stripped PATH: a shortcut/package
 * launch drops every `...\Git\cmd` PATH entry, but the installer always writes
 * `HKLM\SOFTWARE\GitForWindows`. Querying it lets us find a real Git Bash even
 * when the inherited PATH has no Git directory at all. Cached; empty when
 * reg.exe is unavailable or no key is present.
 */
function registryGitRoots(): string[] {
  if (_registryRoots !== null) return _registryRoots;
  const roots: string[] = [];
  if (isWindows()) {
    const sysRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    const regExe = join(sysRoot, "System32", "reg.exe");
    if (existsFile(regExe)) {
      for (const key of [
        "HKLM\\SOFTWARE\\GitForWindows",
        "HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows",
        "HKCU\\SOFTWARE\\GitForWindows",
      ]) {
        try {
          const out = execFileSync(regExe, ["query", key, "/v", "InstallPath"], {
            encoding: "utf8",
            timeout: 4000,
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
          });
          const m = /REG_SZ\s+(.+)$/m.exec(out);
          if (m) {
            const r = m[1].trim();
            if (r && !roots.includes(r)) roots.push(r);
          }
        } catch {
          // Key absent or reg.exe unavailable — not an error, keep scanning.
        }
      }
    }
  }
  _registryRoots = roots;
  return roots;
}

/**
 * Every candidate Git-for-Windows / MSYS2 install root on this machine, derived
 * from PATH (`...\Git\cmd` → `...\Git`, `<drive>:\...` → `<drive>:\Git`), the
 * standard Program Files roots, and the registry InstallPath (PATH-independent).
 * Lazy; the PATH scan is cheap, registry results are cached.
 */
function gitRoots(): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const push = (r: string): void => {
    const key = normDir(r);
    if (key && !seen.has(key)) { seen.add(key); roots.push(r); }
  };
  for (const p of (process.env.PATH ?? "").split(";")) {
    const norm = p.trim().replace(/^"|"$/g, "").replace(/\\+$/, "");
    // `...\Git\cmd` or `...\Git\usr\bin` → root = `...\Git`
    const cmdM = /^(.+?)[\\/]cmd$/.exec(norm);
    if (cmdM) push(cmdM[1]);
    const usrBinM = /^(.+?)[\\/]usr[\\/]bin$/.exec(norm);
    if (usrBinM) push(usrBinM[1]);
    // `<drive>:\...\cmd` → sibling `<drive>:\Git`
    const drvM = /^([A-Za-z]):[\\/].*[\\/]cmd$/.exec(norm);
    if (drvM) push(`${drvM[1]}:\\Git`);
  }
  for (const pf of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (pf) push(join(pf, "Git"));
  }
  // Per-user / package-manager installs that a stripped PATH never exposes:
  // LocalAppData (winget "Git.Git" + per-user installs), scoop, choco, msys2.
  for (const base of [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Git") : "",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd", "..") : "",
    process.env.USERPROFILE ? join(process.env.USERPROFILE, "scoop", "apps", "git", "current") : "",
    process.env.ProgramData ? join(process.env.ProgramData, "chocolatey", "lib", "git", "tools") : "",
    process.env.USERPROFILE ? join(process.env.USERPROFILE, "msys64") : "",
    process.env.LocalAppData ? join(process.env.LocalAppData, "msys64") : "",
  ]) {
    if (base && existsFile(join(base, "usr", "bin", "bash.exe"))) push(base);
  }
  for (const r of registryGitRoots()) push(r);
  return roots;
}

/**
 * Directory that holds the Git unix tools (grep/ls/find/sed/awk/cp…), i.e. the
 * `usr\bin` of a Git-for-Windows / MSYS2 install. Prepending this to a child's
 * PATH is what lets bash-style commands find `grep`, `cp`, `sed` even when the
 * app was launched with a minimal PATH. Cached; null when not found or not win32.
 */
export function gitUnixToolsPath(): string | null {
  if (isWindows() && _cached.unixToolsPath !== undefined) return _cached.unixToolsPath;
  const hasGrep = (dir: string): boolean => existsFile(join(dir, "grep.exe")) || existsFile(join(dir, "grep"));
  const pick = (): string | null => {
    if (!isWindows()) return null;
    // 1. A PATH dir that already holds grep (Git Bash-style environment).
    for (const p of (process.env.PATH ?? "").split(";")) {
      const dir = p.trim().replace(/^"|"$/g, "");
      if (dir && !isSystemDir(dir) && hasGrep(dir)) return dir;
    }
    // 2. `usr\bin` of any discovered Git root (incl. registry roots).
    for (const root of gitRoots()) {
      const ub = join(root, "usr", "bin");
      if (hasGrep(ub)) return ub;
    }
    return null;
  };
  _cached.unixToolsPath = pick();
  return _cached.unixToolsPath;
}

/**
 * A real bash.exe (Git Bash / MSYS2), resolved explicitly — never via `PATH`
 * lookup by name, so it works even when PATH is stripped. Priority:
 *   1. dir holding the unix tools + `bash.exe` (Git `usr\bin`)
 *   2. any Git root's `bin\bash.exe` / `usr\bin\bash.exe` (incl. registry roots)
 *   3. any PATH dir that directly holds `bash.exe`
 * Every candidate is validated NOT to be a Windows system dir — on Win11 with
 * WSL enabled, `%SystemRoot%\System32\bash.exe` is the WSL launcher shim, and
 * accepting it would route every shell command into WSL (the "WSL is
 * initializing" failure). Cached; null on non-win32 or when no Git Bash is
 * installed.
 */
export function gitBashPath(): string | null {
  if (isWindows() && _cached.bashPath !== undefined) return _cached.bashPath;
  const pick = (): string | null => {
    if (!isWindows()) return null;
    const realBash = (p: string): boolean => {
      // Reject absences and Windows system dirs (System32\bash.exe = WSL shim).
      // Real Git Bash / MSYS2 bash.exe is a few MB; the WSL launcher shim is
      // only ~86KB, so a size floor also guards against shims sitting outside
      // the obvious system dirs.
      if (!existsFile(p) || isSystemDir(dirname(p))) return false;
      try { if (statSync(p).size < 400000) return false; } catch { return false; }
      return true;
    };
    const ut = gitUnixToolsPath();
    if (ut) {
      const b = join(ut, "bash.exe");
      if (realBash(b)) return b;
    }
    for (const root of gitRoots()) {
      // `bin\bash.exe` (Git for Windows ships a bash shim there) then
      // `usr\bin\bash.exe` — the latter may be the only real bash present.
      const b = join(root, "bin", "bash.exe");
      if (realBash(b)) return b;
      const ub = join(root, "usr", "bin", "bash.exe");
      if (realBash(ub)) return ub;
    }
    for (const p of (process.env.PATH ?? "").split(";")) {
      const dir = p.trim().replace(/^"|"$/g, "");
      if (dir) {
        const b = join(dir, "bash.exe");
        if (realBash(b)) return b;
      }
    }
    return null;
  };
  _cached.bashPath = pick();
  return _cached.bashPath;
}

/**
 * A real git.exe (Git for Windows), resolved explicitly for the ouroboros:git
 * tool — under a stripped PATH `git` won't resolve by name in cmd.exe, so we
 * hand over the absolute path (registry-backed when PATH lacks Git dirs).
 * Cached; null on non-win32 or when git isn't installed.
 */
export function gitExePath(): string | null {
  if (isWindows() && _cached.gitPath !== undefined) return _cached.gitPath;
  const pick = (): string | null => {
    if (!isWindows()) return null;
    for (const root of gitRoots()) {
      for (const sub of ["cmd", "bin", join("mingw64", "bin")]) {
        const g = join(root, sub, "git.exe");
        if (existsFile(g)) return g;
      }
    }
    for (const p of (process.env.PATH ?? "").split(";")) {
      const dir = p.trim().replace(/^"|"$/g, "");
      if (dir && !isSystemDir(dir)) {
        const g = join(dir, "git.exe");
        if (existsFile(g)) return g;
      }
    }
    return null;
  };
  _cached.gitPath = pick();
  return _cached.gitPath;
}

/** The cmd.exe to use for Windows `shell` execution. Resolved, never PATH-by-name. */
export function cmdExe(): string {
  if (isWindows() && _cached.cmd != null) return _cached.cmd;
  const pick = (): string => {
    if (!isWindows()) return "cmd.exe";
    const spec = process.env.ComSpec || process.env.comspec;
    if (spec && spec.trim()) return spec.trim();
    const sysRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    const candidate = join(sysRoot, "System32", "cmd.exe");
    if (existsFile(candidate)) return candidate;
    return "cmd.exe";
  };
  _cached.cmd = pick();
  return _cached.cmd;
}

/** System32 + Windows dirs, guaranteed present for every Windows child process. */
function windowsSystemDirs(): string[] {
  const sysRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return [join(sysRoot, "System32"), sysRoot];
}

/**
 * A known-good environment for a shelled-out child: `base` (default process.env)
 * with Git's unix-tools dir + `System32` + `Windows` guaranteed at the FRONT of
 * PATH (deduped, case-insensitive, never dropping existing entries). The unix
 * tools come first so `find`/`grep`/`sort` resolve to the MSYS versions the
 * agent's commands expect; System32/Windows follow so `cmd.exe`/`chcp`/
 * `taskkill`/`powershell` always resolve. Non-Windows: returned unchanged.
 */
export function buildShellEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(base ?? process.env) };
  if (!isWindows()) return env;
  // Keep existing entries in first-occurrence order, deduped case-insensitively.
  const existing: string[] = [];
  const have = new Set<string>();
  for (const p of (env.PATH ?? "").split(";")) {
    if (p.trim() === "") continue;
    const key = normDir(p);
    if (have.has(key)) continue;
    have.add(key);
    existing.push(p);
  }
  const toPrepend: string[] = [];
  const maybeAdd = (d: string): void => {
    if (!d) return;
    if (have.has(normDir(d))) return;
    have.add(normDir(d));
    toPrepend.push(d);
  };
  const ut = gitUnixToolsPath();
  if (ut) maybeAdd(ut);
  // Git's `cmd` dir so `git` resolves by name in cmd.exe-driven children even
  // when the inherited PATH is stripped (registry-backed under shortcut launch).
  for (const root of gitRoots()) {
    const gd = join(root, "cmd");
    if (existsFile(join(gd, "git.exe"))) maybeAdd(gd);
  }
  for (const d of windowsSystemDirs()) maybeAdd(d);
  env.PATH = [...toPrepend, ...existing].join(";");
  // cmd.exe resolves `*.cmd` shims (chcp/taskkill/npx/…) through PATHEXT; a
  // mangled user env whose PATHEXT dropped `.CMD` makes them invisible even
  // when the directory is on PATH. Force the Windows standard set so the
  // engine's shelled-out tools never depend on the inherited PATHEXT.
  const pathext = (env.PATHEXT ?? "").trim();
  if (pathext && !/\.CMD\b/i.test(pathext)) {
    env.PATHEXT = ".COM;.EXE;.BAT;.CMD;" + pathext;
  } else if (!pathext) {
    env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
  }
  return env;
}
