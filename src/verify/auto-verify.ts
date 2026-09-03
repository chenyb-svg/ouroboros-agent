// =============================================================================
// Auto-Verify (P0-3) — runs after file edits to catch compile/lint errors.
// Feeds failures back to the model so it can self-repair (the "repair loop").
// Best-effort: never throws; on any error it silently skips.
// =============================================================================

import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".kt", ".java"]);

export interface VerifyResult {
  ran: boolean;      // whether a check actually ran
  pass: boolean;
  summary: string;   // one-line human summary
  errors: string[];  // trimmed error lines for the model
}

let lastVerifyAt = 0;
const DEBOUNCE_MS = 8000; // avoid hammering tsc across a burst of edits

export function shouldVerify(filePath: string): boolean {
  return SOURCE_EXTS.has(extname(filePath).toLowerCase());
}

/** Run a project check after editing `modifiedFiles`. Empty result = nothing to report. */
export async function autoVerify(workDir: string, modifiedFiles: string[]): Promise<VerifyResult> {
  const sources = modifiedFiles.filter(shouldVerify);
  if (sources.length === 0) return { ran: false, pass: true, summary: "", errors: [] };

  // Debounce
  const now = Date.now();
  if (now - lastVerifyAt < DEBOUNCE_MS) return { ran: false, pass: true, summary: "", errors: [] };
  lastVerifyAt = now;

  // 1) TypeScript check (most common here)
  const tsBin = join(workDir, "node_modules", "typescript", "bin", "tsc");
  if (existsSync(tsBin)) {
    const { code, stdout } = await runCheck(`node "${tsBin}" --noEmit`, workDir, 30_000);
    const errors = parseTsErrors(stdout);
    if (code === 0) {
      return { ran: true, pass: true, summary: `Auto-verify: TypeScript compiles clean (${sources.length} file(s) edited)`, errors: [] };
    }
    return {
      ran: true,
      pass: false,
      summary: `Auto-verify: TypeScript check FAILED after editing ${sources.slice(0, 3).join(", ")}`,
      errors,
    };
  }

  // 2) Fallback: npm lint script if present
  try {
    const pkg = JSON.parse(readFileSync(join(workDir, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
    if (pkg?.scripts?.lint) {
      const { code, stdout } = await runCheck("npm run lint", workDir, 30_000);
      if (code === 0) return { ran: true, pass: true, summary: "Auto-verify: lint clean", errors: [] };
      return {
        ran: true,
        pass: false,
        summary: "Auto-verify: lint FAILED",
        errors: (stdout || "").split("\n").map((l) => l.trim()).filter((l) => /error/i.test(l)).slice(0, 15),
      };
    }
  } catch { /* no package.json — nothing to run */ }

  return { ran: false, pass: true, summary: "", errors: [] };
}

function runCheck(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    try {
      const opts: import("node:child_process").ExecOptions = { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, shell: true as any };
      const child = exec(cmd, opts, (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
        resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout: String(stdout) + String(stderr) });
      });
      child.on("error", () => resolve({ code: 1, stdout: "" }));
    } catch {
      resolve({ code: 1, stdout: "" });
    }
  });
}

function parseTsErrors(stdout: string): string[] {
  return stdout.split("\n").map((l) => l.trim()).filter((l) => /error TS\d+/.test(l)).slice(0, 15);
}
