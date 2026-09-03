#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const args = process.argv.slice(2);

/** Lowercase + strip quotes/trailing slashes — for case-insensitive PATH dedup. */
function normDir(p) {
  return p.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "").toLowerCase();
}

/**
 * Known-good env: process.env guaranteed to include System32 + Windows (so
 * cmd.exe / chcp / taskkill resolve even under a stripped PATH) plus the repo's
 * node_modules/.bin (npx/tsx fallback). Deduped, never drops existing entries.
 * Mirrors desktop EngineProcessManager's childEnv.
 */
function childEnv(cwd) {
  const env = { ...process.env };
  if (process.platform !== "win32") return env;
  const sysRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const existing = (env.PATH ?? "").split(";").filter((p) => p.trim() !== "");
  const have = new Set(existing.map(normDir));
  const toPrepend = [];
  const maybeAdd = (d) => {
    if (!d) return;
    if (have.has(normDir(d))) return;
    have.add(normDir(d));
    toPrepend.push(d);
  };
  maybeAdd(join(sysRoot, "System32"));
  maybeAdd(sysRoot);
  maybeAdd(join(cwd, "node_modules", ".bin"));
  env.PATH = [...toPrepend, ...existing].join(";");
  return env;
}

/** The cmd.exe to hand to spawn() as the shell — resolved, not PATH-by-name. */
function shellExe() {
  const spec = process.env.ComSpec || process.env.comspec;
  if (spec && spec.trim()) return spec.trim();
  const sysRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return join(sysRoot, "System32", "cmd.exe");
}

const child = spawn("npx", ["tsx", "src/repl.ts", ...args], {
  cwd: projectRoot,
  stdio: "inherit",
  shell: process.platform === "win32" ? shellExe() : true,
  env: childEnv(projectRoot),
});
child.on("exit", (code) => { process.exit(code ?? 0); });
