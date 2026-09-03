// =============================================================================
// Session Resume — Rebuild session state from transcript (Phase 4)
// =============================================================================

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { FormattedMessage } from "../types/messages.js";
import type { SessionState } from "../types/session.js";
import { TranscriptReader } from "./transcript-reader.js";

export interface ResumeResult {
  success: boolean;
  sessionId: string;
  messages: FormattedMessage[];
  sharedState: Record<string, unknown>;
  externalChanges: string[];
  warnings: string[];
  error?: string;
}

/**
 * Resume a previously ended session from disk.
 * Replays transcript to rebuild messages. Checks for external file changes.
 */
export function resumeSession(
  sessionId: string,
  sessionsDir: string,
  workDir: string,
): ResumeResult {
  const sessionDir = join(sessionsDir, sessionId);
  const transcriptPath = join(sessionDir, "transcript.jsonl");
  const metaPath = join(sessionDir, "meta.json");

  if (!existsSync(sessionDir)) {
    return {
      success: false, sessionId, messages: [], sharedState: {},
      externalChanges: [], warnings: [],
      error: `Session directory not found: ${sessionDir}`,
    };
  }

  // Load metadata
  let meta: any = {};
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch { /* continue */ }

  // Replay transcript to rebuild messages
  const reader = new TranscriptReader(transcriptPath);
  const events = reader.readAll();
  const messages: FormattedMessage[] = [];
  const sharedState: Record<string, unknown> = {};
  // Tool calls the current LLM turn emitted, collected from TOOL_CALL events.
  // The transcript orders them TOOL_CALL(s) → LLM_RESPONSE_COMPLETE → TOOL_RESULT(s),
  // so they're attached to the assistant message when the turn closes, exactly
  // mirroring how queryLoop builds `toolCalls` for the live conversation.
  let pendingToolCalls: FormattedMessage["toolCalls"] = [];
  let lastAssistantIndex = -1; // index of the most recent assistant in `messages`

  for (const event of events) {
    switch (event.type) {
      case "USER_INPUT":
        messages.push({
          role: "user",
          content: (event.payload as any).text ?? "",
        });
        break;
      case "LLM_RESPONSE_COMPLETE": {
        const fullText = (event.payload as any).fullText ?? "";
        const toolCalls = pendingToolCalls.length > 0 ? pendingToolCalls : undefined;
        // usage is persisted in the transcript payload so the desktop keeps the
        // per-message token footer across renames / restarts.
        const usage = (event.payload as any).usage;
        messages.push({ role: "assistant", content: fullText, ...(usage ? { usage } : {}), ...(toolCalls ? { toolCalls } : {}) });
        lastAssistantIndex = messages.length - 1;
        pendingToolCalls = [];
        break;
      }
      case "TOOL_CALL": {
        const tc = event.payload as any;
        pendingToolCalls.push({
          id: String(tc.id),
          type: "function",
          function: {
            name: String(tc.name ?? "tool").replace(/:/g, "_"),
            arguments: tc.args ? JSON.stringify(tc.args) : "{}",
          },
        });
        break;
      }
      case "TOOL_RESULT": {
        const tp = event.payload as any;
        messages.push({
          role: "tool",
          content: tp.output ?? "",
          toolCallId: tp.toolCallId,
          toolName: tp.name ?? tp.fqn,
          fqn: tp.fqn,
          success: tp.success,
        });
        // Legacy transcripts (predating TOOL_CALL logging) carry no TOOL_CALL
        // events, so the assistant above has no toolCalls. Attach a synthetic
        // one from the TOOL_RESULT so sanitizeMessages can pair the tool message
        // instead of dropping it — otherwise the tool stream vanishes on resume.
        if (lastAssistantIndex >= 0) {
          const lastAsst = messages[lastAssistantIndex];
          if (!(lastAsst.toolCalls ?? []).some((c: any) => c.id === tp.toolCallId)) {
            lastAsst.toolCalls = [
              ...(lastAsst.toolCalls ?? []),
              {
                id: String(tp.toolCallId),
                type: "function" as const,
                function: {
                  name: String(tp.name ?? tp.fqn ?? "tool").replace(/:/g, "_"),
                  arguments: "{}",
                },
              },
            ];
          }
        }
        break;
      }
      case "SHARED_STATE_CHANGED":
        const ssePayload = event.payload as any;
        sharedState[ssePayload.key] = ssePayload.newValue;
        break;
      case "STATE_CHANGE":
        const scPayload = event.payload as any;
        if (scPayload.current === "rewound") {
          messages.push({
            role: "system",
            content: `[Session rewound: ${scPayload.reason}]`,
          });
        }
        break;
    }
  }

  // Check for external file changes since last session
  const externalChanges: string[] = [];
  const warnings: string[] = [];

  try {
    const diffOutput = execSync("git diff --name-only", {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 5000,
    });
    const changedFiles = diffOutput.trim().split("\n").filter(Boolean);
    if (changedFiles.length > 0) {
      externalChanges.push(...changedFiles);
      warnings.push(
        `External changes detected since last session: ${changedFiles.length} file(s) modified.`,
      );
    }
  } catch {
    // Not a git repo or git not available — skip
  }

  return {
    success: true,
    sessionId,
    messages,
    sharedState,
    externalChanges,
    warnings,
  };
}
