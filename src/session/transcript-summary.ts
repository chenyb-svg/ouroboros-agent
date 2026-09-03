// =============================================================================
// Transcript Summary — bounded display metadata for a session transcript
// Extracted from the engine's listSessions so group_inspect and the desktop
// session list share the same cheap reader. `updatedAt` is NOT derived here —
// it comes from the file mtime (the transcript is appended on every event, so
// mtime ≈ last activity; the in-transcript `timestamp` is a performance.now()
// delta and cannot be shown as wall-clock). Large transcripts (>2MB) are
// scanned head+tail only so reads stay cheap.
// =============================================================================

import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";

export interface TranscriptSummary {
  /** First user message, truncated — what the conversation is about. */
  title: string;
  /** Last user message, truncated — what it was most recently about. */
  preview: string;
  /** Approximate number of user turns. */
  msgCount: number;
}

export function readTranscriptSummary(tPath: string): TranscriptSummary {
  const summary: TranscriptSummary = { title: "", preview: "", msgCount: 0 };
  try {
    if (!existsSync(tPath)) return summary;
    const size = statSync(tPath).size;
    let head = "";
    let tail = "";
    if (size <= 2 * 1024 * 1024) {
      head = readFileSync(tPath, "utf-8");
      tail = head;
    } else {
      const fd = openSync(tPath, "r");
      const hLen = Math.min(128 * 1024, size);
      const hBuf = Buffer.alloc(hLen);
      readSync(fd, hBuf, 0, hLen, 0);
      const tLen = Math.min(128 * 1024, size);
      const tBuf = Buffer.alloc(tLen);
      readSync(fd, tBuf, 0, tLen, size - tLen);
      closeSync(fd);
      head = hBuf.toString("utf-8");
      tail = tBuf.toString("utf-8");
    }
    const count = (s: string): number => (s.match(/"type":"USER_INPUT"/g) ?? []).length;
    summary.msgCount = tail === head ? count(head) : count(head) + count(tail);
    let firstUser = "";
    let lastUser = "";
    for (const line of head.split("\n")) {
      if (!line.includes('"type":"USER_INPUT"')) continue;
      try {
        const e = JSON.parse(line);
        const text = String(e?.payload?.text ?? "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        if (!firstUser) firstUser = text;
        lastUser = text;
      } catch { /* skip malformed line */ }
    }
    summary.title = firstUser.slice(0, 40);
    summary.preview = lastUser.slice(0, 80);
    return summary;
  } catch { return summary; }
}
