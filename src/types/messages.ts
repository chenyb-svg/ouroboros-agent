// Minimal message types (replaces deleted src/loop/ingest.ts)
export interface FormattedMessage {
  role: string;
  content: string;
  toolCallId?: string;
  toolName?: string;
  /** Resolved tool FQN (e.g. ouroboros:bash) — carried through resume → history. */
  fqn?: string;
  /** Tool execution outcome (restored for the desktop activity stream). */
  success?: boolean;
  /** Reconstructed tool calls on a resumed assistant turn (real from TOOL_CALL
   *  events, or synthetic from TOOL_RESULT for legacy transcripts) — lets
   *  sanitizeMessages pair tool messages instead of dropping them after resume. */
  toolCalls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  /** Per-turn token usage recorded at completion. Persisted in the transcript and
   *  carried through resume → history so the desktop's per-message token footer
   *  survives renames / role changes / app restarts. */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}
