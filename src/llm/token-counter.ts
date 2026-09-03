// =============================================================================
// Token Counter — Character-based heuristic + provider-specific counters
// =============================================================================

import type { LlmCallParams } from "./types.js";

/**
 * CJK-script ranges. Chinese/Japanese/Korean chars are each encoded as ~1 token
 * by the common tokenizers (cl100k / o200k / DeepSeek), so they must NOT share
 * the Latin "~3.5 chars ≈ 1 token" average — mixing them into that average
 * undercounts a Chinese-heavy session by ~3× and auto-compaction would fire far
 * too late (or never before the provider rejects the request).
 */
function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) ||   // CJK symbols & punctuation（。、，：；「」）
    (code >= 0x3040 && code <= 0x30ff) ||   // Hiragana + Katakana
    (code >= 0x3400 && code <= 0x4dbf) ||   // CJK Ext A
    (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified Ideographs (main Han block)
    (code >= 0xf900 && code <= 0xfaff) ||   // CJK Compatibility Ideographs
    (code >= 0xfe30 && code <= 0xfe4f) ||   // CJK Compatibility Forms
    (code >= 0xff00 && code <= 0xffef) ||   // Fullwidth forms（，！？：；（））
    (code >= 0x20000 && code <= 0x2a6df) || // CJK Ext B
    (code >= 0x2a700 && code <= 0x2ebef) || // CJK Ext C–F
    (code >= 0x30000 && code <= 0x323af)    // CJK Ext G
  );
}

/** Count CJK-script code points in a string (astral-plane chars handled). */
function countCjk(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    if (code > 0xffff) i++; // skip the low surrogate of a surrogate pair
    if (isCjkCodePoint(code)) n++;
  }
  return n;
}

/**
 * Estimate token count for a list of messages.
 * CJK characters count as ~1 token each; all other text uses the Latin
 * character-based heuristic (1 token ≈ 3.5 chars / ≈ 4 chars for English).
 *
 * In production, integrate with tiktoken (OpenAI) or provider's token API.
 */
export function estimateTokenCount(
  messages: LlmCallParams["messages"],
  systemPrompt?: string,
  tools?: LlmCallParams["tools"],
): number {
  let totalChars = 0;
  let cjkChars = 0;
  const add = (s: string): void => {
    totalChars += s.length;
    cjkChars += countCjk(s);
  };

  // System prompt
  if (systemPrompt) {
    add(systemPrompt);
  }

  // Messages
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      add(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          add(block.text);
        } else if (block.type === "tool_result") {
          add(block.content);
        } else if (block.type === "tool_use") {
          add(JSON.stringify(block.input));
        }
      }
    }
  }

  // Tools
  if (tools) {
    for (const tool of tools) {
      add(JSON.stringify(tool));
    }
  }

  // CJK script chars ≈ 1 token each; other text ≈ 3.5 chars/token (conservative).
  const estimatedTokens = Math.ceil(cjkChars + (totalChars - cjkChars) / 3.5);

  return estimatedTokens;
}

/**
 * Check if context is approaching the model limit.
 * Returns true if compression should be triggered.
 */
export function shouldCompress(
  estimatedTokens: number,
  modelMaxTokens: number,
  threshold: number = 0.85,
): boolean {
  return estimatedTokens > modelMaxTokens * threshold;
}
