// =============================================================================
// Knowledge bases — user-curated markdown folders under <dataHome>/knowledge/<name>.
//
// Each KB is a plain folder of .md (or any) text files. The desktop browser reads
// and writes them here; later the agent tool layer can query the same folders, so
// a KB is shared, durable knowledge that both the user and the agents can use.
//
// All paths stay under dataPath("knowledge") — names are sanitized and every join
// is re-checked against the base dir to keep `../` (and friends) out.
// =============================================================================

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataPath } from "../data-home.js";

export interface KnowledgeFile {
  name: string;
  size: number;
  /** Last modified epoch ms — the sort key for a KB's file list. */
  mtime: number;
}

export interface KnowledgeBaseInfo {
  name: string;
  fileCount: number;
  files: KnowledgeFile[];
}

export interface KnowledgeResult {
  ok: boolean;
  error?: string;
  name?: string;
  file?: string;
  content?: string;
}

function kbRoot(): string {
  return dataPath("knowledge");
}

/** Strip path-hostile characters from a KB / file name. CJK is kept; "." survives
 *  (so "notes.md" works) but ".." collapses to "_" to block traversal. */
export function sanitizeName(name: string): string {
  const clean = (name ?? "")
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\.\./g, "_")
    .slice(0, 80);
  return clean;
}

/** Safe absolute path for a KB folder. Callers must check sanitizeName() is non-empty. */
function kbDir(name: string): string {
  return join(kbRoot(), sanitizeName(name));
}

/** True when `p` lives under `base` (path-traversal guard for file operations).
 *  Normalizes separators first — join() emits "/" even on Windows, where sep is "\\". */
function isUnder(base: string, p: string): boolean {
  const baseNorm = base.replace(/\\/g, "/").replace(/\/+$/, "");
  const pNorm = p.replace(/\\/g, "/");
  if (!pNorm.startsWith(baseNorm + "/")) return false;
  const rel = pNorm.slice(baseNorm.length + 1);
  return !rel.split("/").includes("..");
}

export function listKnowledge(): KnowledgeBaseInfo[] {
  const root = kbRoot();
  if (!existsSync(root)) return [];
  const out: KnowledgeBaseInfo[] = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    let files: KnowledgeFile[] = [];
    try {
      files = readdirSync(dir, { withFileTypes: true })
        .filter((f) => f.isFile())
        .map((f) => {
          let size = 0;
          let mtime = 0;
          try {
            const st = statSync(join(dir, f.name));
            size = st.size;
            mtime = st.mtimeMs;
          } catch { /* unreadable file → zeroed stats */ }
          return { name: f.name, size, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch { /* unreadable KB → empty file list */ }
    out.push({ name: d.name, fileCount: files.length, files });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function createKnowledge(name: string): KnowledgeResult {
  const clean = sanitizeName(name);
  if (!clean) return { ok: false, error: "名称不能为空" };
  const dir = kbDir(clean);
  try {
    mkdirSync(dir, { recursive: true });
    const readme = join(dir, "README.md");
    if (!existsSync(readme)) writeFileSync(readme, `# ${clean}\n\n`, "utf-8");
    return { ok: true, name: clean };
  } catch (e: any) {
    return { ok: false, error: `创建失败：${e?.message ?? e}` };
  }
}

export function readKnowledgeFile(name: string, file: string): KnowledgeResult {
  const dir = kbDir(name);
  const p = join(dir, file);
  if (!isUnder(dir, p)) return { ok: false, error: "非法文件路径" };
  if (!existsSync(p)) return { ok: false, name, file, error: "文件不存在" };
  try {
    return { ok: true, name, file, content: readFileSync(p, "utf-8") };
  } catch (e: any) {
    return { ok: false, name, file, error: `读取失败：${e?.message ?? e}` };
  }
}

export function writeKnowledgeFile(name: string, file: string, content: string): KnowledgeResult {
  const clean = sanitizeName(name);
  if (!clean) return { ok: false, error: "知识库名称不能为空" };
  const fname = sanitizeName(file);
  if (!fname) return { ok: false, name: clean, file, error: "文件名不能为空" };
  const dir = kbDir(clean);
  const p = join(dir, fname);
  if (!isUnder(dir, p)) return { ok: false, name: clean, file, error: "非法文件路径" };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, content ?? "", "utf-8");
    return { ok: true, name: clean, file: fname };
  } catch (e: any) {
    return { ok: false, name: clean, file, error: `写入失败：${e?.message ?? e}` };
  }
}

export function deleteKnowledge(name: string): KnowledgeResult {
  const clean = sanitizeName(name);
  if (!clean) return { ok: false, error: "名称不能为空" };
  const dir = kbDir(clean);
  if (!existsSync(dir)) return { ok: true, name: clean };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, name: clean };
  } catch (e: any) {
    return { ok: false, error: `删除失败：${e?.message ?? e}` };
  }
}
