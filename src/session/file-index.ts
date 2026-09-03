// =============================================================================
// Session File Index — which files did this conversation produce / touch?
//
// The desktop needs "files of this conversation" that (1) survive restarts,
// (2) always point at the CURRENT on-disk version, (3) dedupe identical copies
// keeping the newest, and (4) expire 7 days after the file was last touched.
// The transcript already records every TOOL_CALL with its `args.path` (full,
// restart-safe, includes the toolCallId) — so the authoritative rebuild source
// is the append-only transcript.jsonl, NOT the in-memory messages (capped ~40)
// or the tool output text (truncated to 500 chars on disk, and the coordinator
// write template is overridden to "Written NNB to ..." so a text regex is
// unreliable). Timestamps in the transcript are monotonic, not wall-clock, so
// the 7-day window is anchored to each file's disk mtime (which also refreshes
// when the file is edited outside the session). We only ever READ the transcript
// here — nothing is appended, so history semantics are untouched.
//
// Contents-hash dedup: identical content ≤512KB = "the same file"; only the
// newest copy is listed. Above the cap, files are treated as unique by path.
// =============================================================================

import {
  readFileSync,
  statSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve, basename, join } from "node:path";
import {
  isInsideWorkspace,
  isAllowedOutsideWrite,
  isSystemWriteBlocked,
} from "../security/paths.js";

// ---- public types ------------------------------------------------------------

export type FileOp = "write" | "edit" | "read" | "attach";
export type FileKind = "image" | "text" | "binary";

/** One file entry handed to the desktop (`files` snapshot / `file_written` event). */
export interface SessionFileDTO {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  op: FileOp;
  kind: FileKind;
  toolCallId?: string;
}

// ---- tunables ----------------------------------------------------------------

/** Reference window: a file must have been touched within 7 days of `now`. */
const VALID_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Files above this size are not content-hashed (dedup by path only). */
const HASH_CAP_BYTES = 512 * 1024;
/** `files` snapshot row cap (sorted newest-first). */
const LIST_CAP = 50;
/** Content-hash LRU bound — each entry is ≤512KB, so ≤~128MB worst case. */
const HASH_CACHE_MAX = 256;
/** Binary sniff reads at most this many bytes from the head of the file. */
const SNIFF_BYTES = 4096;

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);

/** Positional read of up to `length` bytes from `start` (readFileSync has no
 *  byte-range form in the installed Node typings). Returns fewer bytes at EOF. */
function readRange(path: string, start: number, length: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    const n = readSync(fd, buf, 0, length, start);
    return n > 0 ? buf.subarray(0, n) : Buffer.alloc(0);
  } finally {
    closeSync(fd);
  }
}

/** A write/edit produced (or re-produced) the file — the event the desktop links
 *  a chip to. A read only observes existing content and must never steal that
 *  anchor. "Newest producing event wins" (write→edit→rewrite all advance the
 *  anchor so the chip always points at the LATEST version), which the UI relies
 *  on to show the newest copy only. */
function isProducer(op: FileOp): boolean {
  return op === "write" || op === "edit";
}

interface Entry {
  key: string;        // canonical (case-folded, forward-slash) absolute path
  path: string;       // original absolute path string (for display / preview)
  op: FileOp;
  toolCallId?: string;
  live: boolean;      // recorded by this process at runtime (authoritative)
  /** The USER picked this file (📎 attach) — it may legitimately live outside
   *  the workspace, so listing skips the containment / system guards for it. */
  userPick: boolean;
}

interface TranscriptBinding {
  path: string;
  watermark: number;  // byte offset already consumed
}

// ---- module state ------------------------------------------------------------

/** sessionId → canonical path → latest/strongest entry. */
const sessions = new Map<string, Map<string, Entry>>();
/** sessionId → transcript path + consumed-byte watermark (incremental scan). */
const bindings = new Map<string, TranscriptBinding>();
/** content-hash LRU: key `${canon}|${size}|${mtimeMs}` → hex sha1. */
const hashCache = new Map<string, string>();
let hashCacheTail: string | null = null;

function canon(p: string): string {
  return resolve(p).replace(/[\\/]+/g, "/").toLowerCase();
}

function invalidateHash(path: string): void {
  const key = canon(path);
  for (const k of [...hashCache.keys()]) {
    if (k.startsWith(key + "|")) hashCache.delete(k);
  }
}

function contentHashOrNull(path: string, size: number, mtimeMs: number): string | null {
  if (size <= 0 || size > HASH_CAP_BYTES) return null;
  const key = `${canon(path)}|${size}|${mtimeMs}`;
  const hit = hashCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const buf = readFileSync(path);
    const hex = createHash("sha1").update(buf).digest("hex");
    hashCache.delete(hashCacheTail ?? "");
    hashCacheTail = key;
    if (hashCache.size >= HASH_CACHE_MAX) {
      // Drop a quarter of the cache (oldest insertion order) to stay bounded.
      let i = 0;
      for (const k of hashCache.keys()) {
        if (i++ >= HASH_CACHE_MAX / 4) break;
        hashCache.delete(k);
      }
    }
    hashCache.set(key, hex);
    return hex;
  } catch {
    return null;
  }
}

/** Image by extension, otherwise binary-sniff (null bytes / high control density). */
export function classifyKind(path: string): FileKind {
  const name = basename(path);
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  try {
    const st = statSync(path);
    if (st.size === 0) return "text";
    const head = readRange(path, 0, Math.min(st.size, SNIFF_BYTES));
    let nulls = 0;
    for (const b of head) if (b === 0) nulls++;
    // A few stray control bytes are fine in UTF-8; a real binary is full of them.
    return nulls > 0 && nulls > head.length / 16 ? "binary" : "text";
  } catch {
    return "text";
  }
}

// ---- bash-produced files -------------------------------------------------------
// A successful bash command may create/update files the model never routed
// through a write/edit/read tool (cp/mv/touch, ffmpeg/convert/magick, > redirects,
// generator scripts, …). The desktop expects those to appear too — an image the
// agent produced via bash should be previewable like one it wrote. A whole-workspace
// disk diff is too expensive and too racy under concurrent agents, so instead we
// extract path-like operands from the command text and keep the ones that actually
// resolve to a file afterwards. To avoid claiming a file was PRODUCED when the
// agent only consulted it (cat/grep), only operands with clear write semantics
// (redirect targets, -o/--output values, operands of file-producing or interpreter
// verbs) are recorded as write/edit (→ a chip); everything else is recorded as
// "read" — it still shows in the "+" conversation list but never as a produced chip.

/** Cap on files recorded from one command (defensive against pathological argv). */
const BASH_FILES_CAP = 32;

/** Verbs whose non-flag operands are outputs/copies (cp/mv/touch…, image & media
 *  converters, archivers, downloaders). */
const FILE_PRODUCING_VERBS = new Set<string>([
  "cp", "mv", "ln", "touch", "tee", "dd", "install",
  "convert", "magick", "mogrify", "composite", "ffmpeg", "ffprobe",
  "zip", "unzip", "7z", "7za", "tar", "gzip", "gunzip", "xz", "bzip2", "bunzip2", "rar", "unrar",
  "wget", "curl", "scp", "rsync",
  "openssl", "cwebp", "dwebp", "gifski", "pngquant", "optipng", "jpegoptim", "pngcrush",
  "sox", "lame", "gs", "dot", "pdftoppm", "pdftocairo",
]);
/** Interpreters: operand[0] is the script/input (consulted), later operands are
 *  likely outputs (python gen.py out.png). */
const INTERPRETER_VERBS = new Set<string>([
  "python", "python3", "py", "node", "deno", "bun", "ruby", "perl", "php", "bash", "sh", "zsh",
]);
/** Media tools whose "-i" introduces an INPUT operand (never a produced output). */
const MEDIA_INPUT_FLAG_VERBS = new Set<string>(["convert", "magick", "mogrify", "composite", "ffmpeg", "ffprobe"]);
const OUTPUT_FLAG_WORDS = new Set<string>(["-o", "-O", "-of", "--output", "--output-file", "--out", "--outdir", "--output-dir"]);
const INPUT_FLAG_WORDS = new Set<string>(["-i", "--input", "--in", "-in", "-if"]);
/** Command wrappers that should be skipped when locating the real verb. */
const VERB_PASSTHROUGH = new Set<string>(["sudo", "env", "nice", "nohup", "command", "time", "timeout"]);

/** Quote-aware whitespace tokenizer (double + single quotes, backslash escapes).
 *  Shell operators glued between words are split out afterwards. */
function shellWords(command: string): string[] {
  const raw: string[] = [];
  let cur = "";
  let q: '"' | "'" | null = null;
  let esc = false;
  for (const ch of command) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { raw.push(cur); cur = ""; } continue; }
    cur += ch;
  }
  if (cur) raw.push(cur);
  // Break any word that still carries shell operators (cmd1&&cmd2, a;b, x|tee).
  const words: string[] = [];
  for (const w of raw) {
    for (const piece of w.split(/[;&|(){}<>]/)) {
      const t = piece.trim();
      if (t) words.push(t);
    }
  }
  return words;
}

/** Target paths of `>` / `>>` (and `2>`…) redirections — always produced files.
 *  Ignores fd copies like `2>&1` / `>&2`. */
function findRedirectTargets(command: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === '"' || ch === "'") {
      const q = ch; i++;
      while (i < command.length && command[i] !== q) i++;
      i++; continue;
    }
    if (ch === ">") {
      let j = i;
      while (command[j] === ">") j++;
      if (command[j] === "&") { // fd redirect (>&2, 2>&1 handled via &) — not a file
        j++;
        while (/[0-9]/.test(command[j] ?? "")) j++;
        i = j; continue;
      }
      while (/\s/.test(command[j] ?? "")) j++;
      let tok = "";
      while (j < command.length && !/\s/.test(command[j]) && !";&|()<>".includes(command[j]) && command[j] !== '"' && command[j] !== "'") {
        tok += command[j]; j++;
      }
      if ((command[j] === '"' || command[j] === "'") && tok === "") { // quoted target "dir out"
        const q = command[j]; j++;
        while (j < command.length && command[j] !== q) { tok += command[j]; j++; }
        if (command[j] === q) j++;
      }
      if (tok && !/^[0-9-]+$/.test(tok)) out.push(tok);
      i = j; continue;
    }
    i++;
  }
  return out;
}

/** Index of the first real command word (skipping options, FOO=bar, wrappers). */
function verbIndex(words: string[]): number {
  for (let i = 0; i < words.length && i < 6; i++) {
    const w = words[i].toLowerCase();
    if (!w || w.startsWith("-") || w.includes("=")) continue; // options / FOO=bar
    if (VERB_PASSTHROUGH.has(w)) continue;
    return i;
  }
  return -1;
}

interface BashCandidate { raw: string; produce: boolean }

/** Deterministic extraction of file operands from a shell command (used identically
 *  by the live results loop and the transcript rebuild). */
function bashCandidates(command: string): BashCandidate[] {
  const words = shellWords(command);
  const verbIdx = verbIndex(words);
  const verb = verbIdx >= 0 ? words[verbIdx].toLowerCase() : "";
  const producing = FILE_PRODUCING_VERBS.has(verb);
  const interpreter = INTERPRETER_VERBS.has(verb);
  const media = MEDIA_INPUT_FLAG_VERBS.has(verb);
  const redirects = new Set(findRedirectTargets(command).map((s) => s.toLowerCase()));
  const out: BashCandidate[] = [];
  let expectOutputValue = false;
  let expectInputValue = false;
  let interpreterSeen = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const lower = word.toLowerCase();
    // Skip the command itself and wrapper words (sudo/env/…) — only operands count.
    if (i === verbIdx || VERB_PASSTHROUGH.has(lower)) {
      expectOutputValue = false; expectInputValue = false;
      continue;
    }
    if (word.startsWith("-")) {
      const eq = word.indexOf("=");
      if (word.startsWith("--") && eq > 0) { // --output=path
        const key = word.slice(0, eq).toLowerCase();
        const val = word.slice(eq + 1);
        if (OUTPUT_FLAG_WORDS.has(key) && val) out.push({ raw: val, produce: true });
        expectOutputValue = false; expectInputValue = false;
        continue;
      }
      const exact = lower;
      if (OUTPUT_FLAG_WORDS.has(exact)) { expectOutputValue = true; expectInputValue = false; continue; }
      if (media && INPUT_FLAG_WORDS.has(exact)) { expectInputValue = true; expectOutputValue = false; continue; }
      const glued = /^-([a-zA-Z])(.+)$/.exec(word);
      if (glued) {
        const letter = glued[1].toLowerCase();
        if (letter === "o") out.push({ raw: glued[2], produce: true });
        else if (media && letter === "i") out.push({ raw: glued[2], produce: false });
      }
      expectOutputValue = false; expectInputValue = false;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue; // env assignment
    let produce: boolean;
    if (expectInputValue) produce = false;
    else if (interpreter) { produce = interpreterSeen; interpreterSeen = true; }
    else produce = expectOutputValue || producing;
    expectOutputValue = false; expectInputValue = false;
    if (redirects.has(lower)) produce = true;
    out.push({ raw: word, produce });
  }
  return out;
}

interface BashFileEffect {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  op: "write" | "edit" | "read";
  kind: FileKind;
}

function ensureSessionMap(sessionId: string): Map<string, Entry> {
  let map = sessions.get(sessionId);
  if (!map) { map = new Map(); sessions.set(sessionId, map); }
  return map;
}

/** Record the file effects of a successful bash command into the session index.
 *  Returns live records (existing files only) for the caller to stream as
 *  `file_written` events — chips under the bash tool message. `cwd` is the dir
 *  the command ran in, so relative operands resolve against it. */
export function registerBashCommand(sessionId: string, command: string, cwd: string, toolCallId?: string): BashFileEffect[] {
  const map = ensureSessionMap(sessionId);
  const effects: BashFileEffect[] = [];
  const seen = new Set<string>();
  for (const cand of bashCandidates(command)) {
    if (effects.length >= BASH_FILES_CAP) break;
    const raw = cand.raw.trim();
    // Skip tokens that can't be literal file names (globs, expansions, ~).
    if (!raw || /[*?[\]$]/.test(raw) || raw === "~") continue;
    let abs: string;
    try { abs = resolve(cwd, raw); } catch { continue; }
    const key = canon(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    if (isSystemWriteBlocked(abs)) continue;
    if (!(isInsideWorkspace(abs) || isAllowedOutsideWrite(abs))) continue;
    const prev = map.get(key);
    const op: "write" | "edit" | "read" = cand.produce ? (prev ? "edit" : "write") : "read";
    mergeEntry(map, key, abs, op, toolCallId, true);
    if (cand.produce) invalidateHash(abs);
    effects.push({ path: abs, name: basename(abs), size: st.size, mtimeMs: st.mtimeMs, op, kind: classifyKind(abs) });
  }
  return effects;
}

/** Replay bash effects from a transcript line (live=false — disk provenance). */
function replayBash(map: Map<string, Entry>, command: string, cwd: string, toolCallId: string | undefined): number {
  let n = 0;
  for (const cand of bashCandidates(command)) {
    const raw = cand.raw.trim();
    if (!raw || /[*?[\]$]/.test(raw) || raw === "~") continue;
    let abs: string;
    try { abs = resolve(cwd, raw); } catch { continue; }
    const key = canon(abs);
    try { if (!statSync(abs).isFile()) continue; } catch { continue; }
    if (isSystemWriteBlocked(abs)) continue;
    if (!(isInsideWorkspace(abs) || isAllowedOutsideWrite(abs))) continue;
    const prev = map.get(key);
    const op: "write" | "edit" | "read" = cand.produce ? (prev ? "edit" : "write") : "read";
    mergeEntry(map, key, abs, op, toolCallId, false);
    n++;
  }
  return n;
}

// ---- user-attached files (📎) --------------------------------------------------
// When the user attaches a file in the desktop and sends it, the path is inlined
// as a "📎 <abs path>" line of a USER_INPUT message. Replaying those markers on
// transcript scan makes attachments part of the SAME existence-checked, 7-day
// windowed, deduped list as tool-written files (so a moved/deleted attachment
// disappears instead of lingering as a ghost row). Entries are flagged userPick,
// which lets them live outside the workspace.
const ATTACH_MARKER_RE = /📎[ \t]+([^\r\n]+)/g;

/** Parse 📎 markers out of one user message and register each existing file. */
function scanUserAttachMarkers(map: Map<string, Entry>, text: string): number {
  if (!text) return 0;
  ATTACH_MARKER_RE.lastIndex = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTACH_MARKER_RE.exec(text))) {
    const raw = m[1].trim();
    // Only absolute paths are trusted (the attach UI inlines absolute paths, and
    // file CONTENT pasted into the message may coincidentally contain "📎 …").
    if (!raw || !/^([A-Za-z]:[\\/]|\/)/.test(raw)) continue;
    try {
      const abs = resolve(raw);
      if (!statSync(abs).isFile()) continue;
      if (isSystemWriteBlocked(abs)) continue;
      mergeEntry(map, canon(abs), abs, "attach", undefined, false, true);
      n++;
    } catch { /* unreadable marker — ignore */ }
  }
  return n;
}

// ---- recording ----------------------------------------------------------------

/** Merge a newly-seen event for `key` into the session's entry map.
 *  Precedence: a live record (this process, current time) always beats a disk
 *  rebuild; equal-provenance ties go to the LATER event (newest wins); a weaker
 *  op (e.g. a read) never downgrades an existing stronger one (write/edit). */
function mergeEntry(map: Map<string, Entry>, key: string, abs: string, op: FileOp, toolCallId: string | undefined, live: boolean, userPick = false): void {
  const prev = map.get(key);
  // "User picked" is sticky: once a file is a user attachment it may live
  // outside the workspace, so no later op (read/edit rewrite) should drop the
  // containment exemption the listing relies on.
  const pick = userPick || Boolean(prev?.userPick);
  if (prev) {
    if (prev.live !== live) {
      // Live wins over disk outright — a runtime edit today outranks a scanned
      // "write" from yesterday for the same path, whatever the op letter is.
      if (!live) return;
    } else if (!isProducer(op) && isProducer(prev.op)) {
      return; // a read must not hide/rewrite a recorded write/edit
    } else if (op === prev.op && toolCallId === prev.toolCallId) {
      return; // idempotent duplicate of the very same event
    }
    // Otherwise: a newer producing event (write/edit) supersedes an older one,
    // and read-after-read advances too — the entry always anchors the newest.
  }
  map.set(key, { key, path: abs, op, toolCallId, live, userPick: pick });
}

/** Upsert one file this process observed being written/edited/read. */
export function registerSessionFile(
  sessionId: string,
  op: FileOp,
  path: string,
  toolCallId?: string,
  userPick = false,
): void {
  let map = sessions.get(sessionId);
  if (!map) {
    map = new Map();
    sessions.set(sessionId, map);
  }
  const abs = resolve(path);
  const key = canon(abs);
  mergeEntry(map, key, abs, op, toolCallId, true, userPick);
  invalidateHash(abs);
}

/** Drop a session's in-memory index + scan watermark — used after clear_history
 *  archives its transcript, so the next scan starts from the fresh (empty) file
 *  instead of resuming from a stale byte offset into the archived content. */
export function resetSessionFileIndex(sessionId: string): void {
  sessions.delete(sessionId);
  bindings.delete(sessionId);
}

// ---- bash workspace-tree diff --------------------------------------------------
// Some files bash produces never appear as a command operand — the path lives
// inside inline code (`python -c "…img.save('out.png')"`), a heredoc body, or a
// generator that derives its own output name. Operand extraction cannot see them,
// so after a plausibly-writing bash we diff the tree it ran in: any file that
// newly appeared (write) or changed size/mtime (edit) while it ran was produced
// by it. The desktop must still see these after a restart, so the same detection
// is persisted as a FILE_WRITTEN transcript line that the rebuild scan replays —
// live chips and restart-rebuilt lists stay identical.
// =============================================================================

/** Bounded walk: never descend below this depth from the run dir. */
const TREE_MAX_DEPTH = 6;
/** …and stop after this many files (defensive on giant monorepos). */
const TREE_MAX_FILES = 1500;
/** Heavy/vendored dirs never indexed (they're not workspace artifacts anyway). */
const TREE_SKIP_DIRS = new Set<string>([
  ".git", ".hg", ".svn", "node_modules", "dist", "out", "build", "target", ".next",
  ".nuxt", ".turbo", ".nx", ".svelte-kit", ".parcel-cache", ".eslintcache",
  ".cache", ".yarn", ".venv", "venv", "env", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".ruff_cache", ".idea", ".vscode", ".claude", "coverage", "vendor",
  ".rbenv", ".bundle", "Pods", ".gradle", "releases",
]);

/** First words of a command that plausibly write files (interpreter / producing
 *  verbs plus package-manager & build drivers) → the diff gate. */
const WRITE_VERB_WORDS = new Set<string>([
  ...FILE_PRODUCING_VERBS, ...INTERPRETER_VERBS,
  "npm", "yarn", "pnpm", "cargo", "go", "gradle", "mvn", "make", "cmake",
  "mix", "rails", "bundle", "pip", "pip3", "uv", "conda", "docker", "podman",
  "latex", "pdflatex", "xelatex", "pandoc", "groff",
]);

/** Cheap gate — is `command` plausibly writing files? Pure introspection
 *  (ls / echo / cat / git status / …) skips the (cheap but real) tree walk. */
export function commandMayWrite(command: string): boolean {
  if (!command) return false;
  if (command.includes(">")) return true;
  const words = shellWords(command);
  for (let i = 0; i < words.length && i < 8; i++) {
    let w = words[i].toLowerCase();
    // Windows interpreters arrive as absolute paths (…/python.exe) — match the
    // basename and drop the .exe before checking the verb tables.
    const base = w.replace(/^.*[\\/]/, "").replace(/\.exe$/, "");
    if (WRITE_VERB_WORDS.has(base)) return true;
    if (base === w && (WRITE_VERB_WORDS.has(w) || /^(python|node)\d/.test(w))) return true;
  }
  return false;
}

export interface DirTreeEntry { abs: string; size: number; mtimeMs: number }
export interface DirTreeChange { abs: string; op: "write" | "edit"; size: number; mtimeMs: number }

/** Bounded, scope-filtered snapshot of the files under `root` (canonical-path →
 *  abs + stat). Symlinks are never followed, heavy dirs are skipped, and only
 *  files that would pass the listing guards are kept so the diff can never
 *  register out-of-workspace junk. */
export function snapshotDirTree(root: string): Map<string, DirTreeEntry> {
  const out = new Map<string, DirTreeEntry>();
  const absRoot = resolve(root);
  try {
    if (!statSync(absRoot).isDirectory()) return out;
  } catch { return out; }
  const stack: Array<{ dir: string; depth: number }> = [{ dir: absRoot, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (out.size >= TREE_MAX_FILES) break;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (out.size >= TREE_MAX_FILES) break;
      const abs = join(dir, name);
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;           // never follow links out of the tree
      if (st.isDirectory()) {
        if (depth < TREE_MAX_DEPTH && !TREE_SKIP_DIRS.has(name.toLowerCase())) {
          stack.push({ dir: abs, depth: depth + 1 });
        }
        continue;
      }
      if (!st.isFile()) continue;
      if (isSystemWriteBlocked(abs)) continue;
      if (!(isInsideWorkspace(abs) || isAllowedOutsideWrite(abs))) continue;
      out.set(canon(abs), { abs, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/** New/changed files between a pre-bash and post-bash tree snapshot. Deleted
 *  files need no effect — list() drops them by re-stat-ing every entry. */
export function diffDirTree(before: Map<string, DirTreeEntry>, after: Map<string, DirTreeEntry>): DirTreeChange[] {
  const out: DirTreeChange[] = [];
  for (const [key, cur] of after) {
    if (out.length >= BASH_FILES_CAP) break;
    const prior = before.get(key);
    if (!prior) {
      out.push({ abs: cur.abs, op: "write", size: cur.size, mtimeMs: cur.mtimeMs });
    } else if (cur.size !== prior.size || Math.abs(cur.mtimeMs - prior.mtimeMs) > 1.5) {
      out.push({ abs: cur.abs, op: "edit", size: cur.size, mtimeMs: cur.mtimeMs });
    }
  }
  return out;
}

// ---- transcript rebuild (incremental) ----------------------------------------

function parseToolPath(name: string | undefined, args: unknown): string | null {
  if (typeof name !== "string") return null;
  const op: FileOp | null = name.endsWith(":write") ? "write"
    : name.endsWith(":edit") ? "edit"
    : name.endsWith(":read") ? "read" : null;
  if (!op) return null;
  const a = args as Record<string, unknown> | null | undefined;
  if (!a || typeof a !== "object") return null;
  const p = (a as Record<string, unknown>).path;
  return typeof p === "string" && p.trim() ? p.trim() : null;
}

/** Consume the transcript's newly-appended tail and register any write/edit/read
 *  TOOL_CALL paths not already known to this process (live entries win). Robust
 *  to a torn final line (another engine may still be appending to this file). */
export function scanSessionTranscript(sessionId: string, transcriptPath: string): number {
  if (!existsSync(transcriptPath)) {
    bindings.set(sessionId, { path: transcriptPath, watermark: 0 });
    return 0;
  }
  let size = 0;
  try { size = statSync(transcriptPath).size; } catch { return 0; }
  const binding = bindings.get(sessionId);
  const watermark = binding && binding.path === transcriptPath ? binding.watermark : 0;
  if (size <= watermark) {
    if (!binding) bindings.set(sessionId, { path: transcriptPath, watermark: size });
    return 0;
  }

  let tail = "";
  try {
    tail = readRange(transcriptPath, watermark, size - watermark).toString("utf-8");
  } catch {
    return 0;
  }
  // If the tail doesn't end in a newline, another writer is mid-append (torn
  // last line). Hold that partial line back until the next scan.
  let consumed = tail.length;
  let body = tail;
  if (tail.length > 0 && !tail.endsWith("\n")) {
    const nl = tail.lastIndexOf("\n");
    if (nl >= 0) { consumed = nl + 1; body = tail.slice(0, consumed); }
    else { consumed = 0; body = ""; }
  }
  bindings.set(sessionId, { path: transcriptPath, watermark: watermark + consumed });

  let map = sessions.get(sessionId);
  if (!map) { map = new Map(); sessions.set(sessionId, map); }
  const raw = body.split("\n").filter((l) => l.trim());
  let added = 0;
  for (const line of raw) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || !ev.payload) continue;
    const p = ev.payload as Record<string, unknown>;
    // User messages carry the files the user attached ("📎 <abs path>") — rebuild
    // them so attachments survive restarts in the same list as tool-written files.
    if (ev.type === "USER_INPUT") {
      added += scanUserAttachMarkers(map, typeof p.text === "string" ? p.text : "");
      continue;
    }
    // Bash tree-diff results (python -c img.save(...) & friends — produced paths
    // that never appear as operands). Persisted live so a restart rebuild sees
    // exactly the files the live run detected.
    if (ev.type === "FILE_WRITTEN") {
      const tcId = typeof p.toolCallId === "string" && p.toolCallId ? p.toolCallId : undefined;
      const opRaw = p.op;
      const pth = typeof p.path === "string" && p.path.trim() ? p.path.trim() : null;
      if (pth && (opRaw === "write" || opRaw === "edit")) {
        try {
          const abs = resolve(pth);
          const st = statSync(abs);
          if (st.isFile() && !isSystemWriteBlocked(abs)
              && (isInsideWorkspace(abs) || isAllowedOutsideWrite(abs))) {
            mergeEntry(map, canon(abs), abs, opRaw, tcId, false);
            added++;
          }
        } catch { /* file deleted before rebuild — drop, list() would anyway */ }
      }
      continue;
    }
    if (ev.type !== "TOOL_CALL") continue;
    const path = parseToolPath(p.name as string | undefined, p.args);
    if (path) {
      const abs = resolve(path);
      const key = canon(abs);
      const op = (p.name as string).endsWith(":write") ? "write"
        : (p.name as string).endsWith(":edit") ? "edit" : "read";
      mergeEntry(map, key, abs, op, typeof p.id === "string" ? p.id : undefined, false);
      added++;
      continue;
    }
    // bash produces files without args.path — replay the same operand extraction
    // the live results loop uses, so restart-rebuilt lists match live ones.
    if (typeof p.name === "string" && p.name.endsWith(":bash")) {
      const a = p.args as Record<string, unknown> | null | undefined;
      if (a && typeof a.command === "string") {
        const cwd = typeof a.cwd === "string" && a.cwd.trim() ? a.cwd : process.cwd();
        added += replayBash(map, a.command, cwd, typeof p.id === "string" ? p.id : undefined);
      }
    }
  }
  return added;
}

// ---- listing -------------------------------------------------------------------

/** Scan the given transcript first, then return the filtered, deduped snapshot.
 *  Filters: file must exist, live inside the workspace (or an allowed path), not
 *  be system-protected, and have been touched within the 7-day window. */
export function listSessionFiles(sessionId: string, transcriptPath?: string): SessionFileDTO[] {
  // scanSessionTranscript is incremental: a matching binding resumes from its
  // byte watermark; a fresh/foreign session (different path or none) rewinds to
  // byte 0 and consumes the whole file.
  if (transcriptPath) scanSessionTranscript(sessionId, transcriptPath);
  const map = sessions.get(sessionId);
  if (!map) return [];

  const now = Date.now();
  const rows: Array<SessionFileDTO & { hk: string | null }> = [];
  for (const entry of map.values()) {
    let st;
    try { st = statSync(entry.path); } catch { continue; }          // deleted / moved → gone
    if (!st.isFile()) continue;
    if (now - st.mtimeMs > VALID_WINDOW_MS) continue;               // untouched >7 days
    // User-picked attachments may live outside the workspace by design.
    if (!entry.userPick && isSystemWriteBlocked(entry.path)) continue;
    if (!entry.userPick && !(isInsideWorkspace(entry.path) || isAllowedOutsideWrite(entry.path))) continue;
    rows.push({
      path: entry.path,
      name: basename(entry.path),
      size: st.size,
      mtimeMs: st.mtimeMs,
      op: entry.op,
      kind: classifyKind(entry.path),
      toolCallId: entry.toolCallId,
      hk: contentHashOrNull(entry.path, st.size, st.mtimeMs),
    });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  const out: SessionFileDTO[] = [];
  const seenHashes = new Set<string>();
  for (const row of rows) {
    if (row.hk !== null) {
      if (seenHashes.has(row.hk)) continue;   // identical content → keep the newest copy only
      seenHashes.add(row.hk);
    }
    const { hk: _hk, ...dto } = row;
    out.push(dto);
    if (out.length >= LIST_CAP) break;
  }
  return out;
}

/** Test seam — clear all cached state. */
export function resetFileIndexForTest(): void {
  sessions.clear();
  bindings.clear();
  hashCache.clear();
  hashCacheTail = null;
}
