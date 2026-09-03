// =============================================================================
// LLM Provider Interface — The "driver" abstraction
// All vendor SDKs are hidden behind this single interface.
// =============================================================================

import type { LlmCallParams, LlmChunk } from "./types.js";

/**
 * The single interface that every LLM provider implements.
 * Returns an AsyncGenerator of standardized Chunks.
 * Streaming is REQUIRED — no blocking call allowed in production.
 */
export interface LlmProvider {
  readonly name: string;
  readonly models: string[];

  /**
   * Call the LLM. Returns a streaming async generator of Chunks.
   * The caller must consume all chunks to get the final usage info.
   */
  call(
    params: LlmCallParams,
  ): AsyncGenerator<LlmChunk>;

  /**
   * Estimate token count for a list of messages.
   * If the provider supports exact counting (via API or tiktoken), use it.
   * Otherwise, use character-based heuristic.
   */
  estimateTokenCount(
    messages: LlmCallParams["messages"],
    systemPrompt?: string,
    tools?: LlmCallParams["tools"],
  ): number;
}
