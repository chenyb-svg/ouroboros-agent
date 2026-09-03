// =============================================================================
// LLM Types — Standardized chunk types for the provider abstraction
// All vendor-specific formats are translated to these types.
// =============================================================================

// ---- Chunk ------------------------------------------------------------------

export type ChunkType =
  | "text_delta"
  | "tool_use_start"
  | "tool_use_delta"
  | "tool_use_stop"
  | "usage";

export interface TextDeltaChunk {
  type: "text_delta";
  delta: string;
  index: number;
}

export interface ToolUseStartChunk {
  type: "tool_use_start";
  id: string;
  name: string;
  index: number;
}

export interface ToolUseDeltaChunk {
  type: "tool_use_delta";
  id: string;
  delta: string; // JSON fragment
}

export interface ToolUseStopChunk {
  type: "tool_use_stop";
  id: string;
  name: string;
  /** Parsed JSON arguments */
  parsedArgs?: Record<string, unknown>;
  /** Raw JSON string before parsing */
  rawArgs: string;
}

export interface UsageChunk {
  type: "usage";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type LlmChunk =
  | TextDeltaChunk
  | ToolUseStartChunk
  | ToolUseDeltaChunk
  | ToolUseStopChunk
  | UsageChunk;

// ---- Call Params ------------------------------------------------------------

export interface LlmCallParams {
  messages: LlmMessage[];
  tools?: LlmTool[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** Force tool use behavior */
  toolChoice?: "auto" | "any" | "none";
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | LlmContentBlock[];
  toolCallId?: string;
  name?: string;
  /** Tool calls made by assistant (required by OpenAI before tool responses) */
  toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

export type LlmContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string };

export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// ---- Call Result ------------------------------------------------------------

export interface LlmCallResult {
  text: string;
  toolCalls: ParsedToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "error";
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// ---- Error Classification ---------------------------------------------------

export type LlmErrorKind =
  | "transient"      // retryable: 429, 5xx, network
  | "context"        // 413, context too long → trigger compression
  | "content"        // 400, content filter → log + display
  | "auth"           // 401/403 → fatal
  | "balance"        // 402 / insufficient funds → surface + never retry
  | "timeout";       // no chunks received

export interface LlmError {
  kind: LlmErrorKind;
  message: string;
  statusCode?: number;
  retryable: boolean;
  raw?: unknown;
}
