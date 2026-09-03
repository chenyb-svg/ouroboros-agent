// =============================================================================
// PromptHistory — Global prompt history with search (Phase 6+ TUI)
// =============================================================================

import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "../data-home.js";
import { withFileLock } from "../coordination/file-lock.js";

export interface HistoryEntry {
  input: string;
  timestamp: number;
  sessionId: string;
  skillId?: string;
  outcome?: string;
  projectDir?: string;
}

export class PromptHistory {
  private path: string;
  private entries: HistoryEntry[] = [];
  private maxEntries = 1000;
  private excludePatterns: RegExp[] = [];
  private searchIndex = -1;

  constructor() {
    const historyDir = dataHome();
    if (!existsSync(historyDir)) mkdirSync(historyDir, { recursive: true });
    this.path = join(historyDir, "history.jsonl");
    this.load();
  }

  /** Add an entry to history */
  add(input: string, sessionId: string, outcome?: string, skillId?: string): void {
    // Skip if leading space (privacy)
    if (input.startsWith(" ")) return;

    // Skip if matches exclude patterns
    for (const pat of this.excludePatterns) {
      if (pat.test(input)) return;
    }

    // Dedup: replace if identical to last entry
    const last = this.entries[this.entries.length - 1];
    if (last && last.input === input) {
      last.timestamp = Date.now();
      this.flush();
      return;
    }

    const entry: HistoryEntry = {
      input,
      timestamp: Date.now(),
      sessionId,
      skillId,
      outcome,
      projectDir: process.cwd(),
    };

    this.entries.push(entry);

    // Trim to max entries
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    // Append to file
    try {
      appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf-8");
    } catch { /* non-critical */ }
  }

  /** Search history by keyword */
  search(query: string, limit: number = 20): HistoryEntry[] {
    const lower = query.toLowerCase();
    const keywords = lower.split(/\s+/).filter((k) => k.length > 0);

    return this.entries
      .filter((e) => keywords.every((kw) => e.input.toLowerCase().includes(kw)))
      .slice(-limit)
      .reverse();
  }

  /** Get recent entries for up-arrow navigation */
  getRecent(sessionId?: string, limit: number = 100): HistoryEntry[] {
    const filtered = sessionId
      ? this.entries.filter((e) => e.sessionId === sessionId)
      : this.entries;
    return filtered.slice(-limit).reverse();
  }

  /** Navigate history: returns the input string for up/down arrow */
  navigateUp(currentInput: string): string {
    if (this.searchIndex === -1) {
      // Start navigating from the end
      this.searchIndex = this.entries.length;
    }
    if (this.searchIndex > 0) {
      this.searchIndex--;
      return this.entries[this.searchIndex]?.input ?? currentInput;
    }
    return currentInput;
  }

  navigateDown(currentInput: string): string {
    if (this.searchIndex === -1) return currentInput;
    if (this.searchIndex < this.entries.length - 1) {
      this.searchIndex++;
      return this.entries[this.searchIndex]?.input ?? currentInput;
    }
    this.searchIndex = -1;
    return "";
  }

  /** Reset navigation index (called when new text is typed) */
  resetNavigation(): void {
    this.searchIndex = -1;
  }

  /** Add exclude pattern */
  addExcludePattern(pattern: string): void {
    this.excludePatterns.push(new RegExp(pattern, "i"));
  }

  /**
   * Flush entries to disk. Multiple instances append to the same history file,
   * so a full rewrite must not clobber another instance's entries — lock the
   * file and union disk ∪ memory (keyed by input, newest timestamp wins).
   */
  private flush(): void {
    try {
      withFileLock(this.path, () => {
        const disk = this.loadEntries();
        const byInput = new Map<string, HistoryEntry>();
        for (const e of [...disk, ...this.entries]) byInput.set(e.input, e);
        const merged = [...byInput.values()];
        const tmp = `${this.path}.tmp`;
        writeFileSync(tmp, merged.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
        renameSync(tmp, this.path);
        this.entries = merged;
      });
    } catch { /* */ }
  }

  private loadEntries(): HistoryEntry[] {
    try {
      if (!existsSync(this.path)) return [];
      const raw = readFileSync(this.path, "utf-8");
      return raw
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          try { return JSON.parse(l) as HistoryEntry; } catch { return null; }
        })
        .filter((e): e is HistoryEntry => e !== null);
    } catch { return []; }
  }

  private load(): void {
    this.entries = this.loadEntries();
  }
}
