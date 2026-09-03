// =============================================================================
// Ouroboros Built-in Tools — Claude Code-compatible toolset (~20 tools)
// Each tool has: fqn, description, parameters, risk, permissions, result budget
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, rmdirSync, chmodSync } from "node:fs";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { buildShellEnv, cmdExe, gitBashPath, gitExePath } from "./shell-harness.js";

// GBK/UTF-8 safe decoder for Windows Chinese output
function safeDecode(buf: Buffer): string {
  const utf8 = buf.toString("utf-8");
  // If UTF-8 produced replacement characters, try GBK (common on Chinese Windows)
  if (utf8.includes("�") && process.platform === "win32") {
    try {
      // Use iconv-lite if available, otherwise try latin1→GBK conversion
      const { decode } = require("iconv-lite") as any;
      return decode(buf, "gbk");
    } catch {
      // Fallback: use Buffer transcode (Node 22+)
      try {
        return buf.toString("latin1");  // Raw bytes, may render in terminal correctly
      } catch { return utf8; }
    }
  }
  return utf8;
}
import { join, resolve, extname } from "node:path";
import { isInsideWorkspace, isAllowedOutsideWrite, isSystemWriteBlocked } from "../security/paths.js";
import { sanitizeExternal } from "../security/injection-guard.js";

const T = "string" as const, N = "number" as const, B = "boolean" as const;
const BINARY_EXTS = new Set([".exe",".dll",".so",".dylib",".wasm",".bin",".dat",".zip",".tar",".gz",".7z",".rar",".docx",".pptx",".xlsx",".pdf",".png",".jpg",".jpeg",".gif",".ico",".mp3",".mp4",".avi",".mov",".woff",".woff2",".ttf",".eot",".class",".pyc",".o",".obj",".lib",".a"]);

function isBinaryFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTS.has(ext);
}

// ---- Windows shell harness ----
// Every shell-using tool (bash/grep/search/find/git/docker/notify) runs through
// buildShellEnv() from ./shell-harness.js: a known-good environment that always
// carries Git's unix tools (usr\bin) PLUS C:\Windows\System32 + C:\Windows, so
// the tools work no matter how the app was launched (terminal, Electron
// shortcut, packaged exe) and no matter how stripped the inherited PATH is.
// The local `shellEnv()` alias below keeps all call sites unchanged.
function shellEnv(): NodeJS.ProcessEnv {
  return buildShellEnv();
}

// ---- Pure-Node recursive grep (no external binary needed) ----
// Directory searches are the case that broke under a minimal PATH: the binary
// tier failed, and the old fallback only scanned single files — so a directory
// search returned "No matches" even when there were hits. This walker handles
// files AND directories, with case-insensitivity, context lines and a glob filter,
// so `grep` keeps working whatever the shell environment is.
const GREP_SKIP_DIRS = new Set(["node_modules", ".git", ".ouroboros", "dist", ".claude", "build", ".next", "coverage", "target", ".venv", "__pycache__"]);
const GREP_SKIP_EXTS = new Set([".exe", ".dll", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".wasm", ".map", ".lock", ".woff", ".woff2", ".ttf", ".eot", ".zip", ".tar", ".gz", ".7z", ".pdf", ".mp3", ".mp4"]);

function nodeGrepLines(opts: {
  dir: string;              // file or directory to search
  pattern: string;
  caseInsensitive: boolean;
  context?: number;         // lines of context around each hit (-A/-B/-C)
  glob?: string | null;     // file-name filter, e.g. "*.ts"
  max?: number;
}): string[] {
  const { dir, pattern, caseInsensitive, context = 0, glob = null, max = 200 } = opts;
  const results: string[] = [];
  let src: RegExp;
  try { src = new RegExp(pattern, caseInsensitive ? "gi" : "g"); }
  catch { src = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseInsensitive ? "gi" : "g"); }
  const globRe = glob ? new RegExp(glob.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$") : null;
  const scanText = (path: string, text: string): void => {
    if (results.length >= max) return;
    const lines = text.split("\n");
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      src.lastIndex = 0;
      if (src.test(lines[i])) { hits.push(i); if (hits.length >= max) break; }
    }
    if (hits.length === 0) return;
    const shown = new Set<number>();
    for (const h of hits) {
      for (let i = Math.max(0, h - context); i <= Math.min(lines.length - 1, h + context) && results.length < max; i++) {
        if (shown.has(i)) continue;
        shown.add(i);
        results.push(`${path}:${i + 1}${hits.includes(i) ? ":" : "-"}${lines[i].slice(0, 500)}`);
      }
    }
  };
  const walk = (p: string): void => {
    if (results.length >= max) return;
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isFile()) {
      if (globRe && !globRe.test(p)) return;
      if (st.size > 1_500_000) return;
      if (GREP_SKIP_EXTS.has(extname(p).toLowerCase())) return;
      try {
        const text = readFileSync(p, "utf-8");
        if (text.includes("\u0000")) return; // binary
        scanText(p, text);
      } catch { /* unreadable */ }
    } else if (st.isDirectory()) {
      if (GREP_SKIP_DIRS.has(p.split(/[\\/]/).pop() || "")) return;
      let entries;
      try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of entries) walk(join(p, e.name));
    }
  };
  walk(dir);
  return results.slice(0, max);
}

// ---- Helper: truncate ----
function trunc(s: string, max: number, kind?: string): string {
  if (s.length <= max) return s;
  if (kind === "file") { const lines = s.split("\n"); if (lines.length <= 200) return s; return lines.slice(0, 100).join("\n") + `\n[... ${lines.length - 120} lines truncated ...]\n` + lines.slice(-20).join("\n"); }
  return s.slice(0, max / 2) + `\n[... ${s.length - max} chars truncated ...]\n` + s.slice(-max / 2);
}
function redact(s: string): string {
  return s.replace(/(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']+["']/gi, '$1: "[REDACTED]"')
    .replace(/sk-[a-zA-Z0-9]{32,}/g, "[REDACTED]").replace(/ghp_[a-zA-Z0-9]{36}/g, "[REDACTED]");
}

// ---- P1-D: bash classifier + workspace write gate (wired from repl.ts) ----
let bashClassifier: ((cmd: string) => { class: string; reason?: string }) | null = null;
export function setBashClassifier(fn: ((cmd: string) => { class: string; reason?: string }) | null): void {
  bashClassifier = fn;
}

/** Returns a deny message, or null if the write is allowed (permission-gated via ctx). */
async function guardWrite(path: string, ctx?: any): Promise<string | null> {
  const sys = isSystemWriteBlocked(path);
  if (sys) return `Blocked: cannot write to ${sys}: ${path}`;
  if (isInsideWorkspace(path) || isAllowedOutsideWrite(path)) return null;
  // Outside the workspace — coordinator prompts the user; workers have no hook → hard deny.
  if (ctx?.onWriteOutsideWorkspace && await ctx.onWriteOutsideWorkspace(path)) return null;
  return `Denied: outside workspace — ${path}`;
}

// =============================================================================
// Tool Definitions
// =============================================================================

export const builtinTools: any[] = [

  // ---- ouroboros:time ----
  { fqn: "ouroboros:time", description: "Get current date and time. Use when you need to know what time it is, calculate dates, or timestamp something.", parameters: [], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async () => { const d = new Date(); return { success: true, output: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")} (${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()]})` }; } },

  // ---- ouroboros:read ----
  { fqn: "ouroboros:read", description: "Read a text file with LINE NUMBERS. Output format: 'N: content'. Copy the EXACT line content (without line number prefix) as oldString for ouroboros_edit. Binary files rejected.", parameters: [{ name: "path", type: T, required: true, description: "File path (relative or absolute)" }, { name: "offset", type: N, required: false, description: "Start line number (1-based)" }, { name: "limit", type: N, required: false, description: "Max lines to read (default 200)" }], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async (a: any) => { const p=a.path as string; if(isBinaryFile(p))return{success:false,output:"",error:`Binary file detected: ${p}.`}; try { let content = readFileSync(p, "utf-8"); content = redact(content); if (!isInsideWorkspace(p)) content = sanitizeExternal(content, "external file"); const lines = content.split("\n"); const offset = (a.offset as number) || 1; const start = Math.max(0, offset - 1); const end = (a.limit as number) ? start + (a.limit as number) : start + 200; // Add line numbers so LLM can reference exact lines for edit tool
      const result = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n");
      return { success: true, output: trunc(result, 50000, "file") }; } catch (e: any) { return { success: false, output: "", error: e.message }; } } },

  // ---- ouroboros:write ----
  { fqn: "ouroboros:write", description: "Write content to a file atomically. Creates parent directories automatically.", parameters: [{ name: "path", type: T, required: true, description: "File path" }, { name: "content", type: T, required: true, description: "Content to write" }, { name: "append", type: B, required: false, description: "Append instead of overwrite" }], defaultVisibility: "Worker", dangerous: true, source: "builtin",
    execute: async (a: any, ctx?: any) => {
      const gate = await guardWrite(a.path as string, ctx);
      if (gate) return { success: false, output: "", error: gate };
      try { const dir = resolve(a.path as string, ".."); if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); const flag = a.append ? "a" : "w"; writeFileSync(a.path as string, a.content as string, { encoding: "utf-8", flag }); const size = statSync(a.path as string).size; const preview = (a.content as string).split("\n").slice(0, 3).join("\n"); return { success: true, output: `Written ${size} bytes to ${a.path}\nPreview:\n${preview}`, modifiedFiles: [a.path as string] }; } catch (e: any) { return { success: false, output: "", error: e.message }; } } },

  // ---- ouroboros:edit ----
  { fqn: "ouroboros:edit", description: "Replace text in a file. Three modes: 'line' (startLine/endLine, most reliable), 'string' (oldString exact match), 'whole' (replace entire file). Weak models should use 'whole' mode.", parameters: [
    { name: "path", type: T, required: true, description: "File path" },
    { name: "newString", type: T, required: true, description: "Replacement text (or full new content if mode=whole)" },
    { name: "oldString", type: T, required: false, description: "Exact text to replace (mode=string)" },
    { name: "startLine", type: N, required: false, description: "Start line (1-based, mode=line)" },
    { name: "endLine", type: N, required: false, description: "End line inclusive (mode=line)" },
    { name: "mode", type: T, required: false, description: "line | string | whole. Default: line if startLine given, else string if oldString given, else whole." },
  ], defaultVisibility: "Worker", dangerous: true, source: "builtin",
    execute: async (a: any, ctx?: any) => {
      try {
        const p = a.path as string;
        const gate = await guardWrite(p, ctx);
        if (gate) return { success: false, output: "", error: gate };
        const content = readFileSync(p, "utf-8");
        const lines = content.split("\n");
        const mode = (a.mode as string) || ((a.startLine) ? "line" : (a.oldString) ? "string" : "");
        if (!mode) return { success: false, output: "", error: "Specify a mode: mode=\"line\" (startLine), mode=\"string\" (oldString), or mode=\"whole\" (full file replace). whole is safest for weak models." };
        const newStr = a.newString as string;
        let old: string = "";

        // WHOLE FILE MODE — most reliable for weak models
        if (mode === "whole") {
          writeFileSync(p, newStr, "utf-8");
          return { success: true, output: `Replaced entire file ${p} (${newStr.length} chars)`, modifiedFiles: [p] };
        }

        // LINE MODE — extract by line numbers
        if (mode === "line") {
          const sl = (a.startLine as number) || 1;
          const el = (a.endLine as number) || sl;
          if (sl < 1 || el > lines.length) return { success: false, output: "", error: `Line out of range. File has ${lines.length} lines, requested ${sl}-${el}. Try mode=whole for full replacement.` };
          old = lines.slice(sl - 1, el).join("\n");
        }
        // STRING MODE — exact match
        else {
          old = a.oldString as string;
          if (!old) return { success: false, output: "", error: "Provide oldString or use mode=whole." };
        }

        const count = content.split(old).length - 1;
        if (count === 0) {
          const preview = lines.slice(0, 10).map((l, i) => `${i + 1}: ${l.slice(0, 100)}`).join("\n");
          return { success: false, output: "", error: `Text not found. If unsure of exact text, re-read file then use mode=whole to replace entire content. File start:\n${preview}` };
        }
        const updated = content.replace(old, newStr);
        writeFileSync(p, updated, "utf-8");
        return { success: true, output: `Replaced ${mode === "line" ? `lines ${a.startLine}-${a.endLine || a.startLine}` : "1 occurrence"} in ${p}\nOld: ${old.slice(0, 80)}\nNew: ${newStr.slice(0, 80)}`, modifiedFiles: [p] };
      } catch (e: any) { return { success: false, output: "", error: e.message }; }
    } },

  // ---- ouroboros:bash ----
  { fqn: "ouroboros:bash", description: `Execute a shell command. Returns exit code, timing, stdout, and stderr.

POWERFUL: run compilers, formatters, git, package managers, scripts, and CLI tools.
Use for: npm/pip/cargo installs, git operations, file manipulation, code generation tools,
Python/Node.js scripts, database queries, docker, ffmpeg, pandoc, unzip, etc.

OUTPUT: stdout + stderr + elapsed time + idle time. Keeps running while producing output.
Killed after 60s of no output (stuck detection) or when timeout expires.
No hard time limit — long builds/downloads are fine as long as they show progress.`,
    parameters: [
      { name: "command", type: T, required: true, description: "Shell command or pipeline to execute" },
      { name: "cwd", type: T, required: false, description: "Working directory (default: project root)" },
      { name: "timeout", type: N, required: false, description: "Max runtime in ms (default 120s, no hard limit). Command keeps running as long as it produces output. Auto-killed only if idle for 120s." },
      { name: "description", type: T, required: false, description: "Brief description of what this command does (shown in UI)" },
    ], defaultVisibility: "Worker", dangerous: true, source: "builtin",
    execute: async (a: any, ctx?: any) => {
      const cmd = a.command as string;
      const desc = (a.description as string) || cmd.slice(0, 60);
      const cwd = (a.cwd as string) || process.cwd();

      // Safety: classify via BashSandbox (rules merged with config permissions.dangerousCommands)
      if (bashClassifier) {
        const cls = bashClassifier(cmd);
        if (cls?.class === "dangerous") {
          return { success: false, output: "", error: `BLOCKED by sandbox: ${cls.reason || "dangerous command pattern"}` };
        }
      }

      return new Promise((resolve) => {
        const startTime = performance.now();
        const requestedTimeout = (a.timeout as number) || 120000; // no max — LLM decides
        const IDLE_TIMEOUT = 60000; // 1 min silence = stuck
        const STALL_TIMEOUT = 30000; // 30s of <100B/s = stalled
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        let timedOut = false;
        let lastOutputTime = startTime;
        let recentBytes = 0; // bytes in current stall window

        // Shell harness (Claude Code-style): on Windows run through REAL Git Bash
        // so $PWD, /c/... MSYS paths, pipes and the unix toolset (cp/grep/sed) work
        // natively — cmd.exe could never execute the LLM's bash idioms. Fall back to
        // cmd.exe only when no Git Bash is installed, with a NON-fatal `chcp` boot:
        // `&&` previously short-circuited the real command when chcp (System32)
        // wasn't on PATH, silently failing EVERY bash call ("Exit 1 / 0B out").
        // buildShellEnv() guarantees System32/Windows + Git usr\bin in the child env.
        const child: ChildProcess = (() => {
          const env = { ...shellEnv(), PYTHONIOENCODING: "utf-8", LANG: "en_US.UTF-8" };
          if (process.platform === "win32") {
            const bash = gitBashPath();
            if (bash) return spawn(bash, ["--noprofile", "--norc", "-c", cmd], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
            return spawn(cmdExe(), ["/d", "/s", "/c", `chcp 65001 >nul 2>nul & ${cmd}`], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
          }
          return spawn(cmd, [], { cwd, shell: true, env, stdio: ["ignore", "pipe", "pipe"] });
        })();

        // Force-kill helper
        let killedByUser = false;
        const forceKill = () => {
          if (child.killed) return;
          if (process.platform === "win32" && child.pid) {
            try { execSync(`taskkill /F /T /PID ${child.pid} 2>nul`, { timeout: 5000, env: shellEnv() }); } catch {}
          } else {
            try { child.kill("SIGKILL"); } catch {}
          }
        };

        // Smart timeout: resets on output, kills only if idle or stalled too long
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        const resetIdleTimer = () => {
          lastOutputTime = performance.now();
          recentBytes = 0;
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            timedOut = true;
            process.stdout.write(`\n  [No output for ${IDLE_TIMEOUT / 1000}s — killing]\n`);
            forceKill();
          }, IDLE_TIMEOUT);
        };
        const checkStall = () => {
          if (recentBytes > 100) { recentBytes = 0; } // still alive, reset
          else {
            timedOut = true;
            process.stdout.write(`\n  [Stalled — <100B in ${STALL_TIMEOUT / 1000}s — killing]\n`);
            forceKill();
          }
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(checkStall, STALL_TIMEOUT);
        };
        resetIdleTimer(); // Start idle detection
        stallTimer = setTimeout(checkStall, STALL_TIMEOUT); // Start stall detection

        // Real-time streaming + elapsed time
        process.stdout.write(`\n  [${desc.slice(0, 50)}]\n`);
        child.stdout!.on("data", (d: Buffer) => { chunks.push(d); process.stdout.write(d); recentBytes += d.length; resetIdleTimer(); });
        child.stderr!.on("data", (d: Buffer) => { errChunks.push(d); process.stderr.write(d); recentBytes += d.length; resetIdleTimer(); });
        const elapsedTimer = setInterval(() => {
          const elapsed = Math.round((performance.now() - startTime) / 1000);
          const idle = Math.round((performance.now() - lastOutputTime) / 1000);
          process.stdout.write(`\r\x1b[K  ⏱ ${elapsed}s  (idle: ${idle}s)`);
        }, 5000);

        // Ctrl+C interrupt
        if (ctx?.onAbort) {
          ctx.onAbort(() => { killedByUser = true; clearInterval(elapsedTimer); if (idleTimer) clearTimeout(idleTimer); forceKill(); });
        }

        child.on("close", (code: number | null, signal: string | null) => {
          if (idleTimer) clearTimeout(idleTimer);
          if (stallTimer) clearTimeout(stallTimer);
          clearInterval(elapsedTimer);
          const duration = Math.round(performance.now() - startTime);
          const stdout = safeDecode(Buffer.concat(chunks));
          const stderr = safeDecode(Buffer.concat(errChunks));
          const exitCode = code ?? (signal ? 128 + (signal === "SIGTERM" ? 15 : 9) : -1);

          // Format output like Claude Code: exit code, duration, stdout, stderr
          const parts: string[] = [];
          parts.push(`Exit: ${exitCode}${signal ? ` (${signal})` : ""}  |  ${(duration / 1000).toFixed(1)}s  |  ${stdout.length}B out  |  ${stderr.length}B err`);

          // Truncation: head 300 lines + tail 20 lines if too long
          const stdoutLines = stdout.split("\n");
          const maxHead = 300;
          if (stdoutLines.length > maxHead + 40) {
            parts.push(stdoutLines.slice(0, maxHead).join("\n"));
            parts.push(`... ${stdoutLines.length - maxHead - 20} lines truncated ...`);
            parts.push(stdoutLines.slice(-20).join("\n"));
          } else if (stdout.trim()) {
            parts.push(redact(stdout.slice(0, 8000)));
          }

          if (stderr.trim()) {
            parts.push(`--- STDERR ---`);
            parts.push(redact(stderr.slice(0, 2000)));
          }

          if (timedOut) {
            parts.push(`[TIMEOUT — idle for too long, killed]`);
          }
          if (killedByUser) {
            parts.push(`[INTERRUPTED by user]`);
          }

          const description = desc !== cmd.slice(0, 60) ? `[${desc}]\n` : "";
          const fullOutput = description + parts.join("\n");
          // Always include full output (stdout + stderr) so the LLM can diagnose failures
          resolve({
            success: exitCode === 0 && !timedOut && !killedByUser,
            output: fullOutput,
            error: exitCode !== 0 ? `Exit ${exitCode}${timedOut ? " (timeout)" : ""}. Output:\n${fullOutput}` : undefined,
          });
        });

        child.on("error", (err: Error) => {
          if (idleTimer) clearTimeout(idleTimer); if (stallTimer) clearTimeout(stallTimer); clearInterval(elapsedTimer);
          resolve({ success: false, output: "", error: `Failed to start: ${err.message}` });
        });
      });
    } },

  // ---- ouroboros:search ----
  { fqn: "ouroboros:search", description: "Find FILES containing a pattern. Returns file:line:content. Best for: 'where is X defined?', 'which files use Y?'. Uses rg/grep/Node.js.", parameters: [{ name: "pattern", type: T, required: true, description: "Regex or literal pattern" }, { name: "path", type: T, required: false, description: "Search directory (default: project root)" }, { name: "glob", type: T, required: false, description: "File filter e.g. *.ts" }, { name: "caseSensitive", type: B, required: false, description: "Case sensitive search" }, { name: "maxResults", type: N, required: false, description: "Max results (default 50)" }], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async (a: any) => { const ptn = a.pattern as string; const dir = a.path as string || "."; const max = a.maxResults || 50; const caseSensitive = a.caseSensitive === true; const glob = a.glob as string | undefined; const results: string[] = [];
      const NO_MATCH = "__ouroboros_no_match__";
      // Tier 1: try ripgrep
      try { const flags = []; if (!caseSensitive) flags.push("-i"); if (glob) flags.push("-g", glob); const cmd = `rg --no-heading --line-number --color never ${flags.join(" ")} -m ${max} ${JSON.stringify(ptn)} ${JSON.stringify(dir)} 2>nul || echo ${NO_MATCH}`; const out = execSync(cmd, { encoding: "utf-8", timeout: 15000, maxBuffer: 5*1024*1024, env: shellEnv() }).trim(); if (out && !out.includes(NO_MATCH)) { results.push(...out.split("\n").slice(0, max)); } } catch { /* rg not available */ }
      // Tier 2: try grep
      if (results.length === 0) { try { const flags = caseSensitive ? "" : "-i"; const out = execSync(`grep -rn ${flags} ${JSON.stringify(ptn)} ${JSON.stringify(dir)} 2>nul || echo ${NO_MATCH}`, { encoding: "utf-8", timeout: 15000, maxBuffer: 5*1024*1024, shell: true as any, env: shellEnv() }).trim(); if (out && !out.includes(NO_MATCH)) { results.push(...out.split("\n").slice(0, max)); } } catch { /* grep not available */ } }
      // Tier 3: pure-Node walker (works in any environment)
      if (results.length === 0) { results.push(...nodeGrepLines({ dir: resolve(dir), pattern: ptn, caseInsensitive: !caseSensitive, glob: glob ?? null, max })); }
      return { success: true, output: results.length > 0 ? results.join("\n") : `No matches found for "${ptn}"` }; } },

  // ---- ouroboros:view ----
  { fqn: "ouroboros:view", description: "Browse directory tree with depth control and exclude patterns.", parameters: [{ name: "path", type: T, required: true, description: "Directory path" }, { name: "depth", type: N, required: false, description: "Max depth (default 3)" }, { name: "showHidden", type: B, required: false, description: "Show hidden files" }], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async (a: any) => { const maxDepth = a.depth as number || 3; const showHidden = a.showHidden as boolean || false; const results: string[] = []; const exclude = new Set(["node_modules", ".git", ".ouroboros", "dist"]); function walk(dir: string, prefix: string, depth: number) { if (depth > maxDepth || results.length > 100) return; try { const entries = readdirSync(dir, { withFileTypes: true }); for (const e of entries) { if (!showHidden && e.name.startsWith(".")) continue; if (exclude.has(e.name)) continue; const isDir = e.isDirectory(); const label = isDir ? "📁" : (isBinaryFile(e.name) ? "📦" : "📄"); results.push(`${prefix}${label} ${e.name}${isDir ? "/" : ""}`); if (isDir && depth < maxDepth) walk(join(dir, e.name), prefix + "  ", depth + 1); } } catch {} } walk(a.path as string || ".", "", 0); return { success: true, output: results.slice(0, 100).join("\n") || "Empty directory" }; } },

  // ---- ouroboros:git ----
  { fqn: "ouroboros:git", description: "Git read-only queries: status, diff, log, branch, show. Write subcommands are blocked.", parameters: [{ name: "subcommand", type: T, required: true, description: "status, diff, log, branch, or show" }, { name: "args", type: T, required: false, description: "Extra git arguments" }], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async (a: any) => { const sub = a.subcommand as string; const writeOps = ["commit", "push", "reset", "checkout", "merge", "rebase", "tag"]; if (writeOps.some(w => sub.includes(w))) return { success: false, output: "", error: "Write operations blocked. Use git manually." }; // Resolve git.exe absolutely (registry-backed) so `git` works even when the inherited PATH lacks Git\cmd (shortcut/package launch). Fall back to `git` by name only as a last resort.
      const gitExe = gitExePath(); const cmd = gitExe ? `"${gitExe}" ${sub} ${a.args || ""}`.trim() : `git ${sub} ${a.args || ""}`.trim(); try { const out = execSync(cmd, { encoding: "utf-8", timeout: 10000, maxBuffer: 1 * 1024 * 1024, env: shellEnv(), shell: cmdExe() }); return { success: true, output: trunc(out, 5000) }; } catch (e: any) { return { success: false, output: "", error: e.stderr || e.message }; } } },

  // ---- ouroboros:ls ----
  { fqn: "ouroboros:ls", description: "List directory contents with optional detail view.", parameters: [{ name: "path", type: T, required: false, description: "Directory path (default: cwd)" }, { name: "detailed", type: B, required: false, description: "Show permissions, size, time" }], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async (a: any) => { try { const dir = a.path as string || "."; const entries = readdirSync(dir, { withFileTypes: true }).slice(0, 50); return { success: true, output: entries.map(d => { const s = d.isDirectory() ? statSync(join(dir, d.name)) : statSync(join(dir, d.name)); return `${d.isDirectory() ? "d" : "-"} ${d.name}${d.isDirectory() ? "/" : ""} ${s.size}B ${s.mtime.toISOString().slice(0, 10)}`; }).join("\n") }; } catch (e: any) { return { success: false, output: "", error: e.message }; } } },

  // ---- ouroboros:mkdir ----
  { fqn: "ouroboros:mkdir", description: "Create a directory recursively.", parameters: [{ name: "path", type: T, required: true, description: "Directory path to create" }], defaultVisibility: "Worker", dangerous: false, source: "builtin",
    execute: async (a: any, ctx?: any) => {
      const gate = await guardWrite(a.path as string, ctx);
      if (gate) return { success: false, output: "", error: gate };
      try { mkdirSync(a.path as string, { recursive: true }); return { success: true, output: `Created directory: ${a.path}` }; } catch (e: any) { return { success: false, output: "", error: e.message }; } } },

  // ---- ouroboros:rm ----
  { fqn: "ouroboros:rm", description: "Delete a file or empty directory. Critical: deny-first rules protect .git/ and system paths.", parameters: [{ name: "path", type: T, required: true, description: "Path to delete" }, { name: "recursive", type: B, required: false, description: "Recursive delete" }], defaultVisibility: "Worker", dangerous: true, source: "builtin",
    execute: async (a: any, ctx?: any) => { const p = a.path as string; const denyPaths = [".git", ".ouroboros", "node_modules", "~/.ssh", "/etc", "C:\\Windows"]; if (denyPaths.some(d => resolve(p).includes(d))) return { success: false, output: "", error: "DENIED: Cannot delete protected path: " + p }; const gate = await guardWrite(p, ctx); if (gate) return { success: false, output: "", error: gate }; try { if (a.recursive) { const { rmSync } = await import("node:fs"); rmSync(p, { recursive: true, force: true }); } else { unlinkSync(p); } return { success: true, output: `Deleted: ${p}` }; } catch (e: any) { return { success: false, output: "", error: e.message }; } } },

  // ---- ouroboros:grep ----
  { fqn: "ouroboros:grep", description: "Search for LINES matching a pattern in a specific file or dir. Best for: 'find error in logs', 'grep TODO in src/', 'count occurrences'. Use this (not search) when you know WHERE to look and just need matching lines.", parameters: [{ name: "pattern", type: T, required: true, description: "Search pattern (supports regex with -P flag)" }, { name: "path", type: T, required: true, description: "File or directory to search in" }, { name: "options", type: T, required: false, description: "Extra grep options e.g. '-i -n -A 3 -B 2'" }], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async (a: any) => {
      const ptn = a.pattern as string;
      const target = a.path as string;
      const optsRaw = (a.options as string) || "";
      const caseInsensitive = /\b-i\b/.test(optsRaw);
      const ctxM = /-([AB]|C)\s*(\d+)/.exec(optsRaw);
      const context = ctxM ? parseInt(ctxM[2], 10) : 0;
      // Directory targets need -r, or the binary tiers error ("Is a directory").
      const isDir = (() => { try { return statSync(target).isDirectory(); } catch { return false; } })();
      const rFlag = isDir && !/\b-r\b/.test(optsRaw) ? "-r " : "";
      // Tier 1 rg (recursive by default — no -r), Tier 2 grep: both run with the
      // Unix-tools PATH so they resolve even under a minimal Electron PATH. A
      // missing binary or empty match falls through to the Node tier below.
      // (cmd.exe echoes `echo ""` as the literal two-char `""`, so use a sentinel.)
      const NO_MATCH = "__ouroboros_no_match__";
      try {
        const out = execSync(`rg --no-heading --line-number --color never ${optsRaw} ${JSON.stringify(ptn)} ${JSON.stringify(target)} 2>nul || echo ${NO_MATCH}`, { encoding: "utf-8", timeout: 15000, maxBuffer: 5 * 1024 * 1024, env: shellEnv() }).trim();
        if (out && !out.includes(NO_MATCH)) return { success: true, output: trunc(out, 5000) };
      } catch { /* rg unavailable or no match */ }
      try {
        const out = execSync(`grep ${rFlag}${optsRaw} ${JSON.stringify(ptn)} ${JSON.stringify(target)} 2>nul || echo ${NO_MATCH}`, { encoding: "utf-8", timeout: 15000, maxBuffer: 5 * 1024 * 1024, shell: true as any, env: shellEnv() }).trim();
        if (out && !out.includes(NO_MATCH)) return { success: true, output: trunc(out, 5000) };
      } catch { /* grep unavailable */ }
      // Tier 3: pure Node walker — files AND directories, works in any environment.
      const lines = nodeGrepLines({ dir: target, pattern: ptn, caseInsensitive, context, max: 200 });
      return { success: true, output: lines.length > 0 ? trunc(lines.join("\n"), 5000) : `No matches for "${ptn}" in ${target}` };
    } },

  // ---- ouroboros:find ----
  { fqn: "ouroboros:find", description: "Find files by name pattern, type, or modification time.", parameters: [{ name: "path", type: T, required: true, description: "Search directory" }, { name: "name", type: T, required: false, description: "Name pattern with wildcards" }, { name: "type", type: T, required: false, description: "f for files, d for directories" }, { name: "maxDepth", type: N, required: false, description: "Max depth (default 5)" }], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async (a: any) => {
      const base = a.path as string;
      const namePat = a.name as string | undefined;
      const type = (a.type as string) || "";
      const maxDepth = a.maxDepth as number || 5;
      // Tier 1: find binary (Unix-tools PATH so it resolves under a minimal Electron PATH).
      try {
        let cmd = `find ${JSON.stringify(base)} -maxdepth ${maxDepth}`;
        if (namePat) cmd += ` -name ${JSON.stringify(namePat)}`;
        if (type) cmd += ` -type ${type}`;
        const out = execSync(cmd, { encoding: "utf-8", timeout: 10000, maxBuffer: 1 * 1024 * 1024, env: shellEnv() }).trim();
        return { success: true, output: trunc(out, 5000) || "No results" };
      } catch (e: any) {
        // Tier 2: pure-Node walker (works in any environment).
        try {
          const results: string[] = [];
          const nameRe = namePat
            ? new RegExp(namePat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$")
            : null;
          const walk = (dir: string, depth: number): void => {
            if (depth > maxDepth || results.length >= 200) return;
            let entries;
            try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
              if (results.length >= 200) return;
              const full = join(dir, e.name);
              if (e.isDirectory()) {
                if (GREP_SKIP_DIRS.has(e.name)) continue;
                if (type === "" || type === "d") results.push(full);
                walk(full, depth + 1);
              } else if (e.isFile()) {
                if (type === "d") continue;
                if (nameRe && !nameRe.test(e.name)) continue;
                results.push(full);
              }
            }
          };
          walk(base, 0);
          return { success: true, output: results.length > 0 ? results.join("\n") : "No results" };
        } catch (e2: any) { return { success: false, output: "", error: e2.message }; }
      }
    } },

    // ---- ouroboros:curl ----
  { fqn: "ouroboros:curl", description: "HTTP request for remote resources. Uses Node.js fetch (cross-platform). Supports GET/POST/headers.", parameters: [
    { name: "url", type: T, required: true, description: "URL to fetch" },
    { name: "method", type: T, required: false, description: "HTTP method (default GET)" },
    { name: "headers", type: T, required: false, description: "JSON headers as string" },
    { name: "body", type: T, required: false, description: "Request body for POST" },
  ], defaultVisibility: "Worker", dangerous: false, source: "builtin",
    execute: async (a: any) => {
      const url = a.url as string;
      const blocked = ["localhost", "127.0.0.1", "169.254.169.254", "0.0.0.0", "metadata.google.internal"];
      if (blocked.some(b => url.includes(b))) return { success: false, output: "", error: "SSRF blocked: internal address" };
      try {
        const method = (a.method as string) || "GET";
        const headers: Record<string, string> = { "User-Agent": "Ouroboros/1.0" };
        if (a.headers) { try { Object.assign(headers, JSON.parse(a.headers as string)); } catch {} }
        const opts: any = { method, headers, redirect: "follow", signal: AbortSignal.timeout(15000) };
        if (a.body && method !== "GET") opts.body = a.body as string;
        const r = await fetch(url, opts);
        const text = await r.text();
        return { success: true, output: sanitizeExternal(`HTTP ${r.status}\n${trunc(text, 50000)}`, "web") };
      } catch (e: any) { return { success: false, output: "", error: e.message }; }
    } },

  // ---- ouroboros:webfetch ----
  { fqn: "ouroboros:webfetch", description: "Fetch a web page and extract readable text (strips HTML, JS, CSS). Works on any URL. IMPORTANT: never retry the same URL twice — if it fails or returns nothing, move on.", parameters: [
    { name: "url", type: T, required: true, description: "Web page URL. Do NOT call again with the same URL." },
  ], defaultVisibility: "Worker", dangerous: false, source: "builtin",
    execute: async (a: any) => {
      const url = a.url as string;
      const blocked = ["localhost", "127.0.0.1", "169.254.169.254", "0.0.0.0"];
      if (blocked.some(b => url.includes(b))) return { success: false, output: "", error: "SSRF blocked." };
      try {
        const r = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
          redirect: "follow", signal: AbortSignal.timeout(15000),
        });
        let html = await r.text();
        // Strip scripts, styles, HTML tags -> readable text
        html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ");
        html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
        html = html.replace(/<[^>]+>/g, " ");
        html = html.replace(/&[a-z]+;/gi, " ");
        html = html.replace(/\s+/g, " ").trim();
        return { success: true, output: sanitizeExternal(trunc(html, 30000) || "No readable content extracted", "web") };
      } catch (e: any) { return { success: false, output: "", error: e.message }; }
    } },

  // ---- ouroboros:websearch ----
  { fqn: "ouroboros:websearch", description: "Search the web. Tries multiple backends with resilient parsing. No API key needed.", parameters: [
    { name: "query", type: T, required: true, description: "Search query" },
    { name: "maxResults", type: N, required: false, description: "Max results (default 5)" },
  ], defaultVisibility: "Worker", dangerous: false, source: "builtin",
    execute: async (a: any) => {
      const query = (a.query as string).trim();
      const max = a.maxResults || 5;
      const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

      const tryFetch = async (url: string): Promise<string | null> => {
        try {
          const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "text/html", "Accept-Language": "zh-CN,en" }, signal: AbortSignal.timeout(10000) });
          return r.ok ? await r.text() : null;
        } catch { return null; }
      };

      // Extract results from HTML with multiple regex fallback patterns
      const extractResults = (html: string, patterns: { link: RegExp; snippet?: RegExp }[]): string[] => {
        for (const pat of patterns) {
          const out: string[] = [];
          const links: string[] = [], snippets: string[] = [];
          let lm; while ((lm = pat.link.exec(html)) !== null && links.length < max) links.push(lm[1]);
          if (pat.snippet) {
            let sm; while ((sm = pat.snippet.exec(html)) !== null && snippets.length < max) snippets.push(sm[1].replace(/<[^>]+>/g, "").trim());
          }
          for (let i=0; i<Math.min(links.length, snippets.length || links.length); i++) {
            const snip = snippets[i] || links[i];
            if (links[i] && !links[i].startsWith("/") && snip.length > 10) out.push(`${i+1}. ${snip}\n   ${links[i]}`);
          }
          if (out.length >= 2) return out; // good enough
        }
        return [];
      };

      // Backend 1: DuckDuckGo Lite (fast, simple HTML)
      let html = await tryFetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`);
      if (html) {
        const out: string[] = [];
        // DDG Lite format: extract links and titles
        const simpleRe = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
        let m; while ((m = simpleRe.exec(html)) !== null && out.length < max) {
          const url = m[1]; const title = m[2].trim();
          if (!url.includes("duckduckgo.com") && title.length > 3) out.push(`${out.length+1}. ${title}\n   ${url}`);
        }
        if (out.length >= 2) return { success: true, output: sanitizeExternal(out.join("\n\n"), "web") };
      }

      // Backend 2: DuckDuckGo HTML
      html = await tryFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
      if (html) {
        const results = extractResults(html, [
          { link: /<a[^>]*class="result__a"[^>]*href="([^"]*)"/gi, snippet: /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi },
          { link: /<a[^>]*class="result__url"[^>]*href="([^"]*)"/gi },
        ]);
        if (results.length >= 2) return { success: true, output: sanitizeExternal(results.join("\n\n"), "web") };
      }

      // Backend 3: Bing
      html = await tryFetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}`);
      if (html) {
        const results = extractResults(html, [
          { link: /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi },
        ]);
        // Also try h2 title patterns
        if (results.length < 2) {
          const titleRe = /<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a><\/h2>/gi;
          const out: string[] = [];
          let m; while ((m = titleRe.exec(html)) !== null && out.length < max) {
            out.push(`${out.length+1}. ${m[2].replace(/<[^>]+>/g,"").trim()}\n   ${m[1]}`);
          }
          if (out.length >= 1) return { success: true, output: sanitizeExternal(out.join("\n\n"), "web") };
        }
        if (results.length >= 1) return { success: true, output: sanitizeExternal(results.join("\n\n"), "web") };
      }

      // Backend 4: Google (last resort)
      html = await tryFetch(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`);
      if (html) {
        const out: string[] = [];
        const gRe = /<a[^>]*href="\/url\?q=(https?:\/\/[^"&]+)[^"]*"[^>]*>([^<]+)<\/a>/gi;
        let m; while ((m = gRe.exec(html)) !== null && out.length < max) {
          const url = decodeURIComponent(m[1]); const title = m[2].replace(/<[^>]+>/g, "").trim();
          if (title.length > 5 && !url.includes("google.com")) out.push(`${out.length+1}. ${title}\n   ${url}`);
        }
        if (out.length >= 1) return { success: true, output: sanitizeExternal(out.join("\n\n"), "web") };
      }

      return { success: true, output: `No results for "${query}" from any search engine. Try:\n- Use simpler keywords\n- Try English if query is in Chinese\n- Use ouroboros:webfetch to open a specific URL directly` };
    } },

  // ---- ouroboros:github ----
  { fqn: "ouroboros:github", description: "GitHub API operations (read PRs, issues, create comments). Requires GITHUB_TOKEN.", parameters: [{ name: "operation", type: T, required: true, description: "getPR, getIssue, searchCode, searchRepo" }, { name: "repo", type: T, required: false, description: "owner/repo (default: detected from git remote)" }, { name: "number", type: N, required: false, description: "PR or Issue number" }], defaultVisibility: "Worker", dangerous: false, source: "builtin",
    execute: async (a: any) => { const token = process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"]; if (!token) return { success: false, output: "", error: "GITHUB_TOKEN not set" }; const repo = a.repo || "unknown/unknown"; const op = a.operation as string; try { let url = `https://api.github.com/repos/${repo}`; if (op === "getPR" && a.number) url += `/pulls/${a.number}`; else if (op === "getIssue" && a.number) url += `/issues/${a.number}`; const r = await fetch(url, { headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.github+json", "User-Agent": "Ouroboros" }, signal: AbortSignal.timeout(10000) }); const data = await r.json() as any; return { success: true, output: sanitizeExternal(JSON.stringify({ title: data.title, state: data.state, body: (data.body || "").slice(0, 1000), url: data.html_url }, null, 2), "web") }; } catch (e: any) { return { success: false, output: "", error: e.message }; } } },

  // ---- ouroboros:docker ----
  { fqn: "ouroboros:docker", description: "Docker container operations (ps, logs, build, run).", parameters: [{ name: "subcommand", type: T, required: true, description: "ps, logs, build, or run" }, { name: "args", type: T, required: false, description: "Extra docker arguments" }], defaultVisibility: "Worker", dangerous: true, source: "builtin",
    execute: async (a: any) => { const sub = a.subcommand as string; const args = a.args || ""; if (["run", "exec"].some(s => sub.includes(s))) return { success: false, output: "", error: "docker run/exec blocked for safety. Use docker manually." }; try { const out = execSync(`docker ${sub} ${args}`, { encoding: "utf-8", timeout: 30000, maxBuffer: 1 * 1024 * 1024, shell: true as any, env: shellEnv() }).trim(); return { success: true, output: trunc(out, 5000) }; } catch (e: any) { return { success: false, output: "", error: e.stderr || e.message || "Docker not available" }; } } },

  // ---- ouroboros:db ----
  { fqn: "ouroboros:db", description: "Database query (read-only SELECT). Write operations blocked.", parameters: [{ name: "connection", type: T, required: true, description: "Connection string or alias" }, { name: "query", type: T, required: true, description: "SQL query (SELECT only)" }], defaultVisibility: "Worker", dangerous: true, source: "builtin",
    execute: async (a: any) => { const q = (a.query as string).trim().toUpperCase(); if (!q.startsWith("SELECT") && !q.startsWith("PRAGMA") && !q.startsWith("EXPLAIN") && !q.startsWith("SHOW") && !q.startsWith("DESCRIBE")) return { success: false, output: "", error: "Only read-only queries allowed (SELECT, SHOW, DESCRIBE, EXPLAIN, PRAGMA). Write operations blocked." }; return { success: false, output: "", error: "Database connections not configured. Add database.connections to ouroboros.config.yaml." }; } },


  // ---- ouroboros:notify ----
  { fqn: "ouroboros:notify", description: "Send a desktop notification when tasks are complete. Works on Windows/macOS/Linux.", parameters: [{ name: "message", type: T, required: true, description: "Summary of completed tasks" }], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async (a: any) => {
      const msg = (a.message as string).replace(/"/g, "'").replace(/`/g, "");
      try {
        if (process.platform === "win32") {
          // PowerShell balloon tip + console banner as reliable fallback
          try {
            execSync(`powershell -Command "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $template.GetElementsByTagName('text')[0].AppendChild($template.CreateTextNode('Ouroboros')) | Out-Null; $template.GetElementsByTagName('text')[1].AppendChild($template.CreateTextNode('${msg}')) | Out-Null; $toast = New-Object Windows.UI.Notifications.ToastNotification($template); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Ouroboros').Show($toast)"`, { timeout: 8000, shell: true, env: shellEnv() } as any);
          } catch {
            execSync(`powershell -Command "Write-Host '🔔 Ouroboros: ${msg}' -ForegroundColor Green"`, { timeout: 5000, shell: true, env: shellEnv() } as any);
          }
        } else if (process.platform === "darwin") {
          execSync(`osascript -e 'display notification "${msg}" with title "Ouroboros"' 2>/dev/null || echo "🔔 ${msg}"`, { timeout: 5000, shell: true } as any);
        } else {
          execSync(`notify-send "Ouroboros" "${msg}" 2>/dev/null || echo "🔔 ${msg}"`, { timeout: 5000, shell: true } as any);
        }
        return { success: true, output: `🔔 ${msg}` };
      } catch { return { success: true, output: `🔔 ${msg}` }; }
    } },

  // ---- ouroboros:ask (placeholder — execute set by repl.ts) ----
  { fqn: "ouroboros:ask", description: "Ask another running Ouroboros instance a question and BLOCK until it replies (up to 120s). Get session ids from ouroboros:instances. Use when another agent likely already has the data or answer you need (e.g. it worked on the same file or just ran the computation) — ask instead of re-doing the work. If no reply arrives in time you may retry or ask a different instance.", parameters: [
    { name: "target", type: T, required: true, description: "Target instance session id (from ouroboros:instances)" },
    { name: "question", type: T, required: true, description: "The question to ask" },
  ], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async () => ({ success: false, output: "", error: "Coordination system not initialized." }) },

  // ---- ouroboros:send_message (placeholder — execute set by repl.ts) ----
  { fqn: "ouroboros:send_message", description: "Send a message to another running Ouroboros instance by session id. Use ouroboros:instances or /instances to see who is online and get their session ids. Useful to hand off context or ask another agent for status.", parameters: [
    { name: "target", type: T, required: true, description: "Target instance session id (from ouroboros:instances)" },
    { name: "message", type: T, required: true, description: "Message text" },
  ], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async () => ({ success: false, output: "", error: "Coordination system not initialized." }) },

  // ---- ouroboros:groups (placeholder — execute set by repl.ts) ----
  // Read-only discovery: lists all agent groups + the caller's own role. Never
  // includes transcripts — cross-group READ access is gated behind group_inspect.
  { fqn: "ouroboros:groups", description: "List all agent groups (id, name, member count) plus your own group/role if you belong to one. Read-only — no transcripts.", parameters: [], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async () => ({ success: false, output: "", error: "Group system not initialized." }) },

  // ---- ouroboros:group_inspect (placeholder — execute set by repl.ts) ----
  // dangerous:true → the existing permission modal always asks before cross-group read.
  { fqn: "ouroboros:group_inspect", description: "Read another agent group's manifest (members, roles, purpose) and bounded transcript excerpts of its members. Requires user approval — this is the approved channel for cross-group read access.", parameters: [
    { name: "groupId", type: T, required: true, description: "Target group id (from ouroboros:groups)" },
  ], defaultVisibility: "all", dangerous: true, source: "builtin",
    execute: async () => ({ success: false, output: "", error: "Group system not initialized." }) },

  // ---- ouroboros:instances (placeholder — execute set by repl.ts) ----
  { fqn: "ouroboros:instances", description: "List other running Ouroboros instances (name, session id, state, current task, device).", parameters: [], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async () => ({ success: false, output: "", error: "Coordination system not initialized." }) },

  // ---- ouroboros:load_skill (placeholder — execute set by repl.ts) ----
  { fqn: "ouroboros:load_skill", description: "Load full skill instructions. Call with skill_name before processing documents.", parameters: [{ name: "skill_name", type: T, required: true, description: "Skill: docx, pdf, xlsx, pptx" }], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async () => ({ success: false, output: "", error: "Skill system not initialized." }) },

  // ---- ouroboros:memory (placeholder — execute set by repl.ts) ----
  { fqn: "ouroboros:memory", description: "Search or recall working memory and long-term memory facts.", parameters: [{ name: "operation", type: T, required: true, description: "search, recall, or list" }, { name: "query", type: T, required: false, description: "Search query" }, { name: "limit", type: N, required: false, description: "Max results (default 5)" }], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async () => ({ success: false, output: "", error: "Memory system not initialized." }) },

  // ---- ouroboros:plan_tasks (placeholder — execute set by repl.ts) ----
  { fqn: "ouroboros:plan_tasks", description: "BEFORE starting any multi-step task, call this to create a structured plan. Each item tracked as pending→in_progress→completed.", parameters: [{ name: "tasks", type: T, required: true, description: "JSON array: [{\"content\":\"task desc\",\"id\":1},...]" }], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async () => ({ success: false, output: "", error: "Todo system not initialized." }) },

  // ---- ouroboros:update_todo (placeholder — execute set by repl.ts) ----
  { fqn: "ouroboros:update_todo", description: "Update task status. Call when starting or completing a task from the plan.", parameters: [{ name: "id", type: N, required: true, description: "Task ID from the plan" }, { name: "status", type: T, required: true, description: "in_progress, completed, or cancelled" }], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async () => ({ success: false, output: "", error: "Todo system not initialized." }) },

  // ---- ouroboros:save_memory (placeholder — execute set by repl.ts) ----
  { fqn: "ouroboros:save_memory", description: "Persist an important fact to memory. Use when user expresses a preference, constraint, or project fact.", parameters: [{ name: "fact", type: T, required: true, description: "The fact to remember" }, { name: "category", type: T, required: true, description: "project_setup, user_preference, coding_style, constraint, or correction" }, { name: "scope", type: T, required: false, description: "global, project, or session (auto-selected)" }], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async () => ({ success: false, output: "", error: "Memory system not initialized." }) },

  // ---- ouroboros:correct_memory (placeholder — execute set by repl.ts) ----
  { fqn: "ouroboros:correct_memory", description: "Correct a wrong memory. Call when user contradicts a stored fact.", parameters: [{ name: "old_pattern", type: T, required: true, description: "Keyword pattern to find the wrong memory" }, { name: "corrected_fact", type: T, required: true, description: "The correct fact" }], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async () => ({ success: false, output: "", error: "Memory system not initialized." }) },

  // ---- ouroboros:delegate (placeholder — execute set by repl.ts) ----
  { fqn: "ouroboros:delegate", description: "Delegate an independent subtask to an isolated background worker. Returns a ticket ID. Continue your main work; check results with ouroboros:poll or ouroboros:subtasks. Workers default to read-only tools and cannot write outside the workspace.", parameters: [{ name: "task", type: T, required: true, description: "The subtask to complete" }, { name: "tools", type: T, required: false, description: "Optional extra tool FQNs to give the worker (comma-separated)" }], defaultVisibility: "Coordinator", dangerous: false, source: "builtin",
    execute: async () => ({ success: false, output: "", error: "Delegate system not initialized." }) },

  // ---- ouroboros:poll (placeholder — execute set by repl.ts) ----
  { fqn: "ouroboros:poll", description: "Check the status of a delegated subtask by ticket ID. Returns the result when completed.", parameters: [{ name: "ticketId", type: T, required: true, description: "Ticket ID from ouroboros:delegate" }], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async () => ({ success: false, output: "", error: "Delegate system not initialized." }) },

  // ---- ouroboros:subtasks (placeholder — execute set by repl.ts) ----
  { fqn: "ouroboros:subtasks", description: "List all currently running delegated subtasks with their ticket IDs.", parameters: [], defaultVisibility: "Coordinator", dangerous: false, source: "builtin",
    execute: async () => ({ success: false, output: "", error: "Delegate system not initialized." }) },

  // ---- ouroboros:run_recipe (placeholder — execute set by repl.ts) ----
  { fqn: "ouroboros:run_recipe", description: "Run a saved recipe (reusable workflow) by trigger. If a recipe's description matches the current task, use it instead of doing everything manually. Returns the recipe's step results and final output.", parameters: [{ name: "recipe", type: T, required: true, description: "Recipe trigger, e.g. /research" }, { name: "args", type: T, required: false, description: "Optional JSON object of input args, e.g. {\"target\":\"...\"}" }], defaultVisibility: "Coordinator", dangerous: false, source: "builtin",
    execute: async () => ({ success: false, output: "", error: "Recipe system not initialized." }) },

  // ---- ouroboros:ask_user (placeholder — execute set by repl.ts) ----
  // BLOCKING human-question tool (Claude Code AskUserQuestion equivalent). The
  // desktop shows a dialog (single-select options + free-text custom answer);
  // answering returns to the model as the tool result. If the user isn't looking,
  // a WeChat-style red dot lights in the session list and the call waits (10-min
  // timeout backstop). Both interactive AND autonomous turns may call it.
  { fqn: "ouroboros:ask_user", description: "当你需要用户澄清、做决定，或提供任何你不知道的信息/文件/偏好时，必须调用本工具阻塞等待其作答——这是唯一正式的『向用户提问』方式。绝不能只在回复里写个问题然后结束本轮：那只是一条普通消息，用户不会收到任何提示、你也永远拿不到答案。本工具与 read/edit 同级、随时可调，无需用户先开口。调用后本回合挂起：桌面弹出问题卡片（一次最多 4 题，每题可点选项或直接输入自定义答案）；若用户此刻不在，会在会话列表你的名字旁亮起小红点提醒，你继续等待；最迟 10 分钟超时。答案经工具结果返回，收到后据此继续；超时或被取消时会返回说明，按最佳判断推进即可。调用示例 questions={\"questions\":[{\"id\":\"q1\",\"question\":\"方案A还是方案B？\",\"options\":[\"A\",\"B\"]}]}（id 可省略自动 q1..q4，options 可省略=该题纯自由输入）。注意：本工具是问用户本人；若只是要给其他代理实例发消息，请用 ouroboros:ask，不要混淆。", parameters: [
    { name: "questions", type: "object", required: true, description: "问题集合，JSON 形如 {\"questions\":[{\"id\":\"q1\",\"question\":\"你想问什么？\",\"options\":[\"选项A\",\"选项B\"]}]}。id 可省略（自动 q1..q4）；options 可省略表示该题只允许自由输入。一次 1–4 题。" },
    { name: "context", type: "object", required: false, description: "可选：给用户看的背景说明（当前在做的事 / 为什么需要回答），帮助用户作答。" },
  ], defaultVisibility: "all", dangerous: false, source: "builtin",
    execute: async () => ({ success: false, output: "", error: "Ask-user system not initialized." }) },
];

export const toolCount = builtinTools.length;
