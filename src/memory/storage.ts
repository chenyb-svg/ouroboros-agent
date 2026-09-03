// =============================================================================
// Memory Storage — JSONL-backed 3-tier memory persistence
// Working Memory: ~/.ouroboros/memory/projects/{hash}/working.jsonl
// Long-term Memory: ~/.ouroboros/memory/global/longterm.jsonl
// =============================================================================

import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { dataPath } from "../data-home.js";
import { createHash } from "node:crypto";
import { withFileLock } from "../coordination/file-lock.js";
import type { MemoryEntity, MemoryCategory, MemoryScope, ConfidenceLevel, MemoryQueryResult } from "../types/memory.js";

export class MemoryStorage {
  private workingPath: string;
  private longtermPath: string;
  private workingCache: MemoryEntity[] = [];
  private longtermCache: MemoryEntity[] = [];
  private dirty = false;
  /** Entity ids removed via forget/decay — must stay deleted across the disk-merge. */
  private tombstoned = new Set<string>();
  private globalMemDir = "";
  /** Set when THIS instance holds unflushed user edits/deletes (updateMemory /
   *  removeMemory). Unlike access-count dirt these are NOT yet on disk, so a
   *  reload-if-changed must flush them before re-reading. */
  private hasLocalChanges = false;
  /** Last seen mtimes of the two tier files — change = another process wrote. */
  private diskMtimes: { working: number; longterm: number } = { working: -1, longterm: -1 };

  constructor(projectDir: string) {
    const projectHash = createHash("md5").update(projectDir).digest("hex").slice(0, 16);
    const projectMemDir = dataPath("memory", "projects", projectHash);
    this.globalMemDir = dataPath("memory", "global");

    mkdirSync(projectMemDir, { recursive: true });
    mkdirSync(this.globalMemDir, { recursive: true });

    this.workingPath = join(projectMemDir, "working.jsonl");
    this.longtermPath = join(this.globalMemDir, "longterm.jsonl");

    this.loadAll();
    this.diskMtimes = this.snapshotMtimes();
  }

  private snapshotMtimes(): { working: number; longterm: number } {
    const mt = (p: string): number => {
      try { return statSync(p).mtimeMs; } catch { return 0; }
    };
    return { working: mt(this.workingPath), longterm: mt(this.longtermPath) };
  }

  /**
   * Cross-process freshness check — call at the top of every read path. Another
   * process (the system engine applying a user's memory edit, or a peer agent
   * auto-storing a fact) may rewrite the tier files behind this instance; if so,
   * reload the caches so THIS agent sees the change immediately — no restart and
   * no desktop broadcast needed. Pending local edits/deletes are flushed first so
   * they can never be clobbered by the reload.
   */
  reloadIfChanged(): void {
    try {
      if (this.dirty && this.hasLocalChanges) this.flushToDisk();
      const m = this.snapshotMtimes();
      if (m.working !== this.diskMtimes.working || m.longterm !== this.diskMtimes.longterm) {
        this.loadAll();
        this.diskMtimes = m;
      }
    } catch { /* a read must never throw over a stale cache */ }
  }

  /** Write a memory fact to the appropriate tier */
  write(params: {
    fact: string;
    category: MemoryCategory;
    scope: MemoryScope;
    source: MemoryEntity["source"];
    confidence: ConfidenceLevel;
    ttl?: number;
    conflicts?: string[]; // negativeFacts: patterns of old memories this contradicts
  }): MemoryEntity {
    const entity: MemoryEntity = {
      id: `mem-${randomUUID().slice(0, 8)}`,
      fact: params.fact,
      category: params.category,
      scope: params.scope,
      source: params.source,
      confidence: params.confidence,
      timestamp: Date.now(),
      accessCount: 0,
      lastAccessed: Date.now(),
      ttl: params.ttl,
      negativeFacts: params.conflicts,
    };

    // If this corrects old memories, mark them as deprecated
    if (params.conflicts && params.conflicts.length > 0) {
      for (const pattern of params.conflicts) {
        const regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        for (const cache of [this.workingCache, this.longtermCache]) {
          for (const m of cache) {
            if (!m.negativeFacts) m.negativeFacts = [];
            if (regex.test(m.fact) && !m.negativeFacts.includes(entity.id)) {
              m.negativeFacts.push(entity.id);
            }
          }
        }
      }
      this.dirty = true;
    }

    const isLongTerm = params.confidence === "user_confirmed" || params.scope === "global";
    const targetPath = isLongTerm ? this.longtermPath : this.workingPath;
    const targetCache = isLongTerm ? this.longtermCache : this.workingCache;

    targetCache.push(entity);
    appendFileSync(targetPath, JSON.stringify(entity) + "\n", "utf-8");
    this.dirty = true;

    return entity;
  }

  /** Extract keywords: Chinese bigrams + English words */
  private tokenize(text: string): string[] {
    const tokens: string[] = [];
    // English words
    const words = text.toLowerCase().match(/[a-z0-9_]+/g) || [];
    tokens.push(...words.filter(w => w.length > 1));
    // Chinese characters (CJK Unified + Ext A + Compat) → bigrams
    const cjk = /[一-鿿㐀-䶿豈-﫿]/g;
    const chinese = text.match(cjk)?.join("") || "";
    for(let i=0; i<chinese.length-1; i++) tokens.push(chinese.slice(i, i+2));
    // Single chars for short queries
    if(tokens.length===0) for(const c of chinese) tokens.push(c);
    return [...new Set(tokens)];
  }

  /** Query memories by keyword matching across both tiers */
  query(
    searchText: string,
    topK: number = 10,
    categories?: MemoryCategory[],
  ): MemoryEntity[] {
    this.reloadIfChanged();
    const keywords = this.tokenize(searchText);
    if (keywords.length === 0) return [];

    const allMemories = [...this.longtermCache, ...this.workingCache]
      .filter((m) => !categories || categories.includes(m.category))
      .filter((m) => {
        if (m.ttl && Date.now() - m.timestamp > m.ttl) return false;
        return true;
      });

    // Score: keyword match + category boost + confidence + recency
    const now = Date.now();
    const scored = allMemories.map((m) => {
      let score = 0;
      const factLower = m.fact.toLowerCase();
      for (const kw of keywords) {
        if (factLower.includes(kw)) score += 10;
        if (m.category.includes(kw)) score += 8; // category match boosted
        if (m.scope.includes(kw)) score += 3;
      }
      // Recency boost (newer = higher)
      const ageHours = (Date.now() - m.timestamp) / (1000 * 60 * 60);
      score += Math.max(0, 5 - ageHours * 0.1);
      // Confidence boost
      if (m.confidence === "user_confirmed") score += 20;
      if (m.confidence === "auto_high") score += 10;
      // Access count boost
      score += Math.min(m.accessCount, 5);
      return { entity: m, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Mark accessed
    for (const s of scored.slice(0, topK)) {
      s.entity.accessCount++;
      s.entity.lastAccessed = Date.now();
    }

    this.dirty = true;
    return scored.slice(0, topK).map((s) => s.entity);
  }

  /** Most recent non-expired memories across both tiers, newest first. */
  recent(limit: number = 10): MemoryEntity[] {
    this.reloadIfChanged();
    return [...this.longtermCache, ...this.workingCache]
      .filter((m) => !(m.ttl && Date.now() - m.timestamp > m.ttl))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /** Explicitly forget a memory by pattern match */
  forget(pattern: string): number {
    const regex = new RegExp(pattern, "i");
    let removed = 0;

    this.workingCache = this.workingCache.filter((m) => {
      if (regex.test(m.fact)) { removed++; this.tombstoned.add(m.id); return false; }
      return true;
    });
    this.longtermCache = this.longtermCache.filter((m) => {
      if (regex.test(m.fact)) { removed++; this.tombstoned.add(m.id); return false; }
      return true;
    });

    if (removed > 0) {
      this.flushToDisk();
    }
    return removed;
  }

  /** In-place edit of one memory's fact / category. The entity stays in whatever
   *  tier it currently lives in — edits never migrate tiers (only write() re-tiers). */
  updateMemory(id: string, patch: { fact?: string; category?: MemoryCategory }): { ok: boolean; error?: string } {
    const found = this.workingCache.find((m) => m.id === id) ?? this.longtermCache.find((m) => m.id === id);
    if (!found) return { ok: false, error: "memory not found" };
    if (patch.fact !== undefined) found.fact = patch.fact;
    if (patch.category !== undefined) found.category = patch.category;
    this.hasLocalChanges = true;
    this.dirty = true;
    return { ok: true };
  }

  /** Delete one memory by id. Tombstoned so the removal survives the disk-merge —
   *  deleting a memory is terminal for that fact (mirrors forget()). */
  removeMemory(id: string): { ok: boolean; error?: string } {
    const before = this.workingCache.length + this.longtermCache.length;
    this.workingCache = this.workingCache.filter((m) => m.id !== id);
    this.longtermCache = this.longtermCache.filter((m) => m.id !== id);
    if (this.workingCache.length + this.longtermCache.length === before) {
      return { ok: false, error: "memory not found" };
    }
    this.tombstoned.add(id);
    this.hasLocalChanges = true;
    this.dirty = true;
    return { ok: true };
  }

  private get archivePath(): string {
    return join(this.globalMemDir, "..", "archive.jsonl");
  }

  /** Decay old working memories → archive tier instead of deleting */
  decay(maxAgeDays: number = 30): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const keep: MemoryEntity[] = [];
    const archived: MemoryEntity[] = [];
    for (const m of this.workingCache) {
      if (m.lastAccessed > cutoff) keep.push(m);
      else archived.push(m);
    }
    this.workingCache = keep;
    if (archived.length > 0) {
      // Append to archive
      for (const m of archived) {
        this.tombstoned.add(m.id); // remove from working tier across the disk-merge
        appendFileSync(this.archivePath, JSON.stringify(m) + "\n", "utf-8");
      }
      this.flushToDisk();
    }
    return archived.length;
  }

  /** Query archive (for /memory archive) */
  queryArchive(query: string, limit: number = 10): MemoryQueryResult[] {
    const keywords = this.tokenize(query);
    if (keywords.length === 0) return [];
    const results: MemoryQueryResult[] = [];
    try {
      const raw = readFileSync(this.archivePath, "utf-8");
      const archived = raw.split("\n").filter(Boolean).map(l => JSON.parse(l) as MemoryEntity);
      for (const m of archived) {
        let score = 0;
        for (const kw of keywords) {
          if (m.fact.includes(kw)) score += 8;
        }
        if (score > 0) {
          results.push({
            entity: m,
            score,
            source: "archive" as any,
            conflictingEntities: (m.negativeFacts || []).map(id => archived.find(a => a.id === id)).filter(Boolean) as MemoryEntity[],
          });
        }
      }
      results.sort((a, b) => b.score - a.score);
    } catch {}
    return results.slice(0, limit);
  }

  /** Count of memories in each tier */
  counts(): { working: number; longterm: number; archive?: number } {
    this.reloadIfChanged();
    let archiveCount = 0;
    try { archiveCount = readFileSync(this.archivePath, "utf-8").split("\n").filter(Boolean).length; } catch {}
    return {
      working: this.workingCache.length,
      longterm: this.longtermCache.length,
      archive: archiveCount,
    };
  }

  /** Consolidate similar memories within same category. Returns merged facts. Call periodically (daily/weekly). */
  consolidate(): string[] {
    const merged: string[] = [];
    // Group by category
    const byCategory = new Map<string, MemoryEntity[]>();
    for (const m of [...this.workingCache, ...this.longtermCache]) {
      const list = byCategory.get(m.category) || [];
      list.push(m);
      byCategory.set(m.category, list);
    }
    for (const [cat, mems] of byCategory) {
      if (mems.length < 5) continue; // need at least 5 for consolidation
      // Find memories with overlapping keywords
      const processed = new Set<string>();
      for (let i = 0; i < mems.length; i++) {
        if (processed.has(mems[i].id)) continue;
        const similar: MemoryEntity[] = [mems[i]];
        for (let j = i + 1; j < mems.length; j++) {
          if (processed.has(mems[j].id)) continue;
          // Simple overlap: >50% shared bigrams
          const a = new Set(this.tokenize(mems[i].fact));
          const b = new Set(this.tokenize(mems[j].fact));
          const intersection = new Set([...a].filter(x => b.has(x)));
          const union = new Set([...a, ...b]);
          if (union.size > 0 && intersection.size / union.size > 0.5) {
            similar.push(mems[j]);
            processed.add(mems[j].id);
          }
        }
        if (similar.length >= 3) {
          processed.add(mems[i].id);
          // Merge: take the newest fact as primary, append older ones as context
          similar.sort((a, b) => b.timestamp - a.timestamp);
          const primary = similar[0].fact;
          const context = similar.slice(1).map(m => m.fact.slice(0, 60)).join("; ");
          merged.push(`[${cat}] ${primary} (also: ${context})`);
        }
      }
    }
    return merged;
  }

  /**
   * Save dirty state to disk. Multiple instances share the same memory files
   * (same cwd → same project hash), so a naive full-file rewrite would clobber
   * another instance's appended entities. Instead we lock each tier file and
   * merge what's on disk with our cache (keyed by entity id, cache wins),
   * then write atomically (tmp + rename). Tombstones from forget/decay are
   * applied so removals survive the merge.
   */
  flushToDisk(): void {
    if (!this.dirty) return;
    withFileLock(this.workingPath, () => {
      const disk = this.loadFile(this.workingPath);
      const merged = this.mergeByEntityId(disk, this.workingCache);
      this.workingCache = this.writeEntities(this.workingPath, merged);
    });
    withFileLock(this.longtermPath, () => {
      const disk = this.loadFile(this.longtermPath);
      const merged = this.mergeByEntityId(disk, this.longtermCache);
      this.longtermCache = this.writeEntities(this.longtermPath, merged);
    });
    this.tombstoned.clear();
    this.hasLocalChanges = false;
    this.dirty = false;
    this.diskMtimes = this.snapshotMtimes();
  }

  /** disk entities ∪ cache entities, keyed by id (cache is fresher, wins collisions). */
  private mergeByEntityId(disk: MemoryEntity[], cache: MemoryEntity[]): MemoryEntity[] {
    const byId = new Map<string, MemoryEntity>();
    for (const m of disk) byId.set(m.id, m);
    for (const m of cache) byId.set(m.id, m);
    return [...byId.values()];
  }

  /** Atomically rewrite a tier file (applying tombstones); returns the persisted list. */
  private writeEntities(path: string, entities: MemoryEntity[]): MemoryEntity[] {
    const filtered = entities.filter((m) => !this.tombstoned.has(m.id));
    const content = filtered.map((m) => JSON.stringify(m)).join("\n") + (filtered.length > 0 ? "\n" : "");
    try {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, content, "utf-8");
      renameSync(tmp, path);
    } catch {
      // Fallback: direct write (e.g. tmp rename fails) — still correct enough.
      try { writeFileSync(path, content, "utf-8"); } catch {}
    }
    return filtered;
  }

  private loadAll(): void {
    this.workingCache = this.loadFile(this.workingPath);
    this.longtermCache = this.loadFile(this.longtermPath);
  }

  private loadFile(path: string): MemoryEntity[] {
    if (!existsSync(path)) return [];
    try {
      const raw = readFileSync(path, "utf-8");
      return raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try { return JSON.parse(line) as MemoryEntity; } catch { return null; }
        })
        .filter((m): m is MemoryEntity => m !== null);
    } catch {
      return [];
    }
  }
}
