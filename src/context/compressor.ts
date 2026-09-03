// =============================================================================
// Context Compressor — 2-layer compression pipeline
//
// Layer 1: Tool Result Budget (hard truncation of large results)
// Layer 2: Snip Compact (dropping old conversation turns)
// =============================================================================

import type { FormattedMessage } from "../types/messages.js";

// ---- Layer 1: Tool Result Budget -------------------------------------------

export interface TruncationResult {
  content: string;
  truncated: boolean;
  originalLength: number;
  newLength: number;
  summary: string;
}

/**
 * Truncate tool output based on content type.
 * Preserves head + tail, inserts truncation marker.
 */
export function truncateToolResult(
  output: string,
  kind: "file" | "command" | "list" | "generic",
): TruncationResult {
  const originalLength = output.length;
  let content = output;
  let truncated = false;
  let summary = "";

  switch (kind) {
    case "file": {
      const lines = output.split("\n");
      if (lines.length > 200) {
        const head = lines.slice(0, 100);
        const tail = lines.slice(-20);
        const dropped = lines.length - 120;
        content = [
          ...head,
          `[... ${dropped} lines truncated ...]`,
          ...tail,
        ].join("\n");
        truncated = true;
        summary = `${dropped} lines truncated`;
      }
      break;
    }

    case "command": {
      if (output.length > 5000) {
        const head = output.slice(0, 3000);
        const tail = output.slice(-1000);
        const dropped = output.length - 4000;
        content = `${head}\n[... ${dropped} chars truncated ...]\n${tail}`;
        truncated = true;
        summary = `${dropped} chars truncated`;
      }
      break;
    }

    case "list": {
      const items = output.split("\n").filter((l) => l.trim());
      if (items.length > 50) {
        const head = items.slice(0, 30);
        const tail = items.slice(-10);
        content = [...head, `[... ${items.length - 40} items truncated ...]`, ...tail].join("\n");
        truncated = true;
        summary = `${items.length - 40} items truncated`;
      }
      break;
    }

    default:
      // Generic: truncate at 100KB
      if (output.length > 100_000) {
        content = output.slice(0, 80_000) + `\n[... ${output.length - 100_000} bytes truncated ...]\n` + output.slice(-20_000);
        truncated = true;
        summary = `${output.length - 100_000} bytes truncated`;
      }
      break;
  }

  return {
    content,
    truncated,
    originalLength,
    newLength: content.length,
    summary,
  };
}

/**
 * Auto-detect the kind of tool output based on tool FQN.
 */
export function detectResultKind(toolFqn: string): "file" | "command" | "list" | "generic" {
  if (toolFqn.includes(":read") || toolFqn.includes(":cat")) return "file";
  if (toolFqn.includes(":bash") || toolFqn.includes(":shell") || toolFqn.includes(":exec")) return "command";
  if (toolFqn.includes(":list") || toolFqn.includes(":ls") || toolFqn.includes(":find") || toolFqn.includes(":search")) return "list";
  return "generic";
}

// ---- Layer 2: Snip Compact ------------------------------------------------

export interface SnipResult {
  messages: FormattedMessage[];
  snippedCount: number;
  summary: string;
  /** Boundary marker inserted where messages were snipped */
  boundaryIndex: number;
}

/**
 * Compact conversation history by dropping the oldest text-only turns.
 * Preserves: system messages, recent tool chains, most recent messages.
 */
export function compactHistory(
  messages: FormattedMessage[],
  maxMessages: number,
): SnipResult {
  if (messages.length <= maxMessages) {
    return { messages, snippedCount: 0, summary: "", boundaryIndex: -1 };
  }

  // Strategy: keep system messages + last N messages
  // Drop from the middle (oldest non-system messages)

  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  const toDrop = nonSystemMessages.length - (maxMessages - systemMessages.length);

  if (toDrop <= 0) {
    return { messages, snippedCount: 0, summary: "", boundaryIndex: -1 };
  }

  // Preserve the most recent messages, drop from the front
  const keepMessages = nonSystemMessages.slice(toDrop);
  const droppedMessages = nonSystemMessages.slice(0, toDrop);

  // Build a summary of what was dropped
  const turnRange = droppedMessages.length > 0
    ? `${droppedMessages.length} messages`
    : "";

  const boundaryMarker: FormattedMessage = {
    role: "system",
    content: `[Context compressed: ${turnRange} removed. Summary: ${buildDropSummary(droppedMessages)}]`,
  };

  const result = [
    ...systemMessages,
    boundaryMarker,
    ...keepMessages,
  ];

  return {
    messages: result,
    snippedCount: toDrop,
    summary: buildDropSummary(droppedMessages),
    boundaryIndex: systemMessages.length,
  };
}

function buildDropSummary(messages: FormattedMessage[]): string {
  if (messages.length === 0) return "No messages dropped";

  const userMsgs = messages.filter((m) => m.role === "user");
  const toolMsgs = messages.filter((m) => m.role === "tool");

  const parts: string[] = [];
  if (userMsgs.length > 0) parts.push(`${userMsgs.length} user messages`);
  if (toolMsgs.length > 0) parts.push(`${toolMsgs.length} tool results`);

  // Sample first user message as context
  if (userMsgs[0]) {
    parts.push(`(e.g., "${userMsgs[0].content.slice(0, 80)}...")`);
  }

  return parts.join(", ");
}

// ---- Check Pipeline --------------------------------------------------------

export interface CompressionResult {
  messages: FormattedMessage[];
  /** Whether any compression was applied */
  compressed: boolean;
  /** Description of what was done */
  description: string;
}

/**
 * Run the full compression pipeline on messages before an LLM call.
 * 1. Layer 1: Truncate oversized tool results
 * 2. Layer 2: Snip compact if still over token budget
 *
 * @param messages Current messages
 * @param estimatedTokens Estimated token count
 * @param maxTokens Model's maximum context tokens
 * @param compressThreshold Fraction of maxTokens that triggers compression (default 0.85)
 */
export function checkAndCompress(
  messages: FormattedMessage[],
  estimatedTokens: number,
  maxTokens: number,
  compressThreshold: number = 0.85,
): CompressionResult {
  let compressed = false;
  const descriptions: string[] = [];

  // Layer 1: Truncate tool results
  const layer1Messages = messages.map((msg) => {
    if (msg.role === "tool" && msg.content.length > 5000) {
      const kind = detectResultKind(msg.toolName ?? "generic");
      const truncated = truncateToolResult(msg.content, kind);
      if (truncated.truncated) {
        compressed = true;
        descriptions.push(`Truncated tool result: ${truncated.summary}`);
        return { ...msg, content: truncated.content };
      }
    }
    return msg;
  });

  // Re-estimate after Layer 1
  const afterL1Tokens = estimatedTokens; // Could re-estimate, but heuristic is cheap
  const threshold = maxTokens * compressThreshold;

  // Layer 2: Snip compact
  if (afterL1Tokens > threshold) {
    // Calculate how many messages to keep
    const avgTokensPerMsg = afterL1Tokens / Math.max(1, layer1Messages.length);
    const targetTokens = maxTokens * 0.7; // aim for 70% after compression
    const targetMsgCount = Math.floor(targetTokens / avgTokensPerMsg);

    const snipped = compactHistory(layer1Messages, Math.max(10, targetMsgCount));
    if (snipped.snippedCount > 0) {
      compressed = true;
      descriptions.push(`Compacted ${snipped.snippedCount} old messages`);
      return {
        messages: snipped.messages,
        compressed: true,
        description: descriptions.join("; "),
      };
    }
  }

  return {
    messages: layer1Messages,
    compressed,
    description: descriptions.join("; "),
  };
}

// =============================================================================
// Layer 3: Microcompact — Remove low-relevance tool results (Phase 4)
// =============================================================================

export interface MicrocompactResult {
  messages: FormattedMessage[];
  removedCount: number;
  removedIds: string[];
}

/**
 * L3: Microcompact — scan tool_result blocks, remove those with low relevance
 * to the current task description. Keeps results referenced by subsequent calls.
 */
export function microcompact(
  messages: FormattedMessage[],
  taskDescription: string,
  relevanceThreshold: number = 0.3,
): MicrocompactResult {
  const taskKeywords = taskDescription.toLowerCase().split(/\s+/).filter((k) => k.length > 2);
  if (taskKeywords.length === 0) return { messages, removedCount: 0, removedIds: [] };

  const removedIds: string[] = [];
  const result: FormattedMessage[] = [];
  let removedCount = 0;

  // Find tool results that were referenced by later messages
  const referencedToolIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" || msg.role === "system") {
      for (const tid of messages.filter((m) => m.role === "tool").map((m) => m.toolCallId)) {
        if (tid && msg.content.includes(tid)) referencedToolIds.add(tid);
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === "tool" && msg.content.length > 200) {
      // Calculate relevance
      const contentLower = msg.content.toLowerCase();
      let relevance = 0;
      for (const kw of taskKeywords) {
        if (contentLower.includes(kw)) relevance += 1;
      }
      relevance /= Math.max(1, taskKeywords.length);

      // Keep if referenced or relevant
      const isReferenced = msg.toolCallId && referencedToolIds.has(msg.toolCallId);
      if (!isReferenced && relevance < relevanceThreshold) {
        const snippet = msg.content.slice(0, 100);
        result.push({
          ...msg,
          content: `[microcompact: tool result for ${msg.toolCallId ?? "unknown"} compressed. Original: ${snippet}...]`,
        });
        removedCount++;
        if (msg.toolCallId) removedIds.push(msg.toolCallId);
        continue;
      }
    }
    result.push(msg);
  }

  return { messages: result, removedCount, removedIds };
}

// =============================================================================
// Layer 4: Context Collapse — Group episodes into summary nodes (Phase 4)
// =============================================================================

export interface CollapsedEpisode {
  index: number;
  summary: string;
  originalRange: { start: number; end: number };
}

export interface CollapseResult {
  messages: FormattedMessage[];
  episodes: CollapsedEpisode[];
  collapsedCount: number;
}

/**
 * L4: Context Collapse — groups consecutive user→agent→tools→result→agent
 * episodes into summary nodes. Non-destructive: originals archived.
 */
export function contextCollapse(
  messages: FormattedMessage[],
  maxMessages: number,
): CollapseResult {
  if (messages.length <= maxMessages) {
    return { messages, episodes: [], collapsedCount: 0 };
  }

  const episodes = identifyEpisodes(messages);
  if (episodes.length === 0) return { messages, episodes: [], collapsedCount: 0 };

  // Collapse oldest episodes first until within limit
  const msgToDrop = messages.length - maxMessages;
  let collapsedCount = 0;
  const collapsedEpisodes: CollapsedEpisode[] = [];

  for (const ep of episodes) {
    if (collapsedCount >= msgToDrop / 3) break; // Don't collapse more than needed

    const summary = buildEpisodeSummary(messages.slice(ep.start, ep.end + 1));
    collapsedEpisodes.push({
      index: ep.start,
      summary,
      originalRange: { start: ep.start, end: ep.end },
    });
    collapsedCount += ep.end - ep.start + 1;
  }

  // Build result with collapsed episodes
  const result: FormattedMessage[] = [];
  let cursor = 0;
  for (const ep of collapsedEpisodes) {
    // Add messages before this episode
    while (cursor < ep.originalRange.start) {
      result.push(messages[cursor]);
      cursor++;
    }
    // Add collapsed summary
    result.push({
      role: "system",
      content: `[Context Collapse: ${ep.summary}]`,
    });
    cursor = ep.originalRange.end + 1;
  }
  // Add remaining messages
  while (cursor < messages.length) {
    result.push(messages[cursor]);
    cursor++;
  }

  return { messages: result, episodes: collapsedEpisodes, collapsedCount };
}

interface Episode {
  start: number;
  end: number;
}

function identifyEpisodes(messages: FormattedMessage[]): Episode[] {
  const episodes: Episode[] = [];
  let epStart = -1;

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      if (epStart >= 0) {
        episodes.push({ start: epStart, end: i - 1 });
      }
      epStart = i;
    }
  }
  if (epStart >= 0 && epStart < messages.length) {
    episodes.push({ start: epStart, end: messages.length - 1 });
  }

  return episodes;
}

function buildEpisodeSummary(messages: FormattedMessage[]): string {
  const userMsg = messages.find((m) => m.role === "user");
  const assistantMsgs = messages.filter((m) => m.role === "assistant");
  const toolCount = messages.filter((m) => m.role === "tool").length;

  const userText = userMsg ? userMsg.content.slice(0, 80) : "unknown request";
  const result = assistantMsgs.length > 0
    ? assistantMsgs[assistantMsgs.length - 1].content.slice(0, 100)
    : "no response";

  return `User asked "${userText}", ${toolCount} tool(s) called, result: "${result}"`;
}

// =============================================================================
// Layer 5: Auto-Compact — LLM-powered conversation summarization (Phase 4)
// =============================================================================

export interface AutoCompactResult {
  messages: FormattedMessage[];
  summary: string;
  originalMessageCount: number;
  compactedMessageCount: number;
}

/**
 * L5: Auto-Compact — calls lightweight LLM to summarize conversation.
 * This is the most expensive layer; only triggers when L1-L4 have all failed
 * and context is at 95% capacity.
 */
export async function autoCompact(
  messages: FormattedMessage[],
  provider: { call: (params: any) => AsyncGenerator<{ type: string; delta?: string }> },
): Promise<AutoCompactResult> {
  const originalCount = messages.length;
  const conversationText = messages
    .map((m) => `[${m.role}] ${m.content.slice(0, 500)}`)
    .join("\n");

  const compactPrompt = `Condense the following conversation into a compact summary. Preserve ALL key decisions, constraints, tool outputs, and user preferences. Remove redundant reasoning and repeated attempts. Format as a system message that can stand alone.

## Conversation
${conversationText.slice(0, 8000)}

## Compact Summary`;

  let summary = "";
  try {
    const stream = provider.call({
      messages: [{ role: "user", content: compactPrompt }],
      temperature: 0.1,
      maxTokens: 2000,
    });

    for await (const chunk of stream) {
      if (chunk.type === "text_delta" && chunk.delta) {
        summary += chunk.delta;
      }
    }
  } catch {
    // LLM call failed — fall back to simple concatenation
    summary = messages
      .filter((m) => m.role === "user" || m.role === "system")
      .map((m) => m.content.slice(0, 200))
      .join(" | ");
  }

  return {
    messages: [
      { role: "system", content: `[Auto-Compacted Conversation]\n${summary || "Compaction failed."}` },
    ],
    summary,
    originalMessageCount: originalCount,
    compactedMessageCount: 1,
  };
}
