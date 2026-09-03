// =============================================================================
// Transcript Reader — JSONL replay reader for session resume (Phase 4)
// =============================================================================

import { readFileSync, existsSync } from "node:fs";
import type { OuroborosEvent } from "../types/events.js";

export class TranscriptReader {
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Read all events from the transcript */
  readAll(): OuroborosEvent[] {
    if (!existsSync(this.path)) return [];
    try {
      const raw = readFileSync(this.path, "utf-8");
      return raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try { return JSON.parse(line) as OuroborosEvent; } catch { return null; }
        })
        .filter((e): e is OuroborosEvent => e !== null);
    } catch {
      return [];
    }
  }

  /** Replay events through a callback (for state rebuilding) */
  replay(callback: (event: OuroborosEvent, lineNumber: number) => void): number {
    const events = this.readAll();
    for (let i = 0; i < events.length; i++) {
      callback(events[i], i + 1);
    }
    return events.length;
  }

  /** Count events without loading all */
  count(): number {
    if (!existsSync(this.path)) return 0;
    try {
      const raw = readFileSync(this.path, "utf-8");
      return raw.split("\n").filter((line) => line.trim()).length;
    } catch {
      return 0;
    }
  }
}
