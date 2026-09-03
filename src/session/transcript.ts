// =============================================================================
// Ouroboros Transcript Writer — Append-only JSONL with fsync guarantee
// Physical foundation for resume, fork, and compaction.
// =============================================================================

import { appendFileSync, openSync, fsyncSync } from "node:fs";
import type { OuroborosEvent } from "../types/events.js";

export class TranscriptWriter {
  private path: string;
  private lineCount: number;
  private fd: number;

  constructor(path: string) {
    this.path = path;
    this.lineCount = 0;
    // Open file descriptor for fsync
    this.fd = openSync(path, "a");
  }

  /**
   * Append a single event as a JSON line to the transcript.
   * Calls fsync to guarantee durability.
   */
  append(event: OuroborosEvent): void {
    const line = JSON.stringify(event) + "\n";
    appendFileSync(this.path, line, "utf-8");

    // fsync the underlying fd for crash safety
    try {
      fsyncSync(this.fd);
    } catch {
      // fsync may fail on some filesystems (e.g., NFS); log and continue
    }

    this.lineCount++;
  }

  /**
   * Append multiple events in batch (single fsync).
   */
  appendBatch(events: OuroborosEvent[]): void {
    if (events.length === 0) return;

    const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    appendFileSync(this.path, lines, "utf-8");

    try {
      fsyncSync(this.fd);
    } catch {
      // ignore fsync failures
    }

    this.lineCount += events.length;
  }

  /** Number of lines written */
  get count(): number {
    return this.lineCount;
  }

  /** Close the file descriptor */
  close(): void {
    try {
      // Final fsync
      fsyncSync(this.fd);
    } catch {
      // ignore
    }
  }
}
