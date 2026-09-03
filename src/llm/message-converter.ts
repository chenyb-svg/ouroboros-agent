// =============================================================================
// Message Converter — Internal FormattedMessage → OpenAI message format
// =============================================================================

import type { FormattedMessage } from "../types/messages.js";
import type { LlmMessage, LlmContentBlock } from "./types.js";

/**
 * Convert internal FormattedMessage[] to OpenAI-compatible LlmMessage[].
 */
export function convertMessages(messages: FormattedMessage[]): {
  systemPrompt: string | undefined;
  llmMessages: LlmMessage[];
} {
  let systemPrompt: string | undefined;
  const llmMessages: LlmMessage[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        // Merge system messages into systemPrompt
        if (systemPrompt) {
          systemPrompt += "\n" + msg.content;
        } else {
          systemPrompt = msg.content;
        }
        break;

      case "user":
        llmMessages.push({
          role: "user",
          content: msg.content,
        });
        break;

      case "assistant":
        llmMessages.push({
          role: "assistant",
          content: msg.content,
        });
        break;

      case "tool":
        // Tool results are injected as user messages with tool_result blocks
        // for Anthropic format, or as tool role for OpenAI
        llmMessages.push({
          role: "tool",
          content: msg.content,
          toolCallId: msg.toolCallId,
        });
        break;
    }
  }

  return { systemPrompt, llmMessages };
}

/**
 * Inject tool use blocks from a previous assistant response into message history.
 * This allows the LLM to see its own tool calls in the conversation.
 */
export function injectToolUseHistory(
  messages: LlmMessage[],
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  assistantText?: string,
): LlmMessage[] {
  const content: LlmContentBlock[] = [];

  if (assistantText) {
    content.push({ type: "text", text: assistantText });
  }

  for (const tc of toolCalls) {
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: tc.args,
    });
  }

  if (content.length > 0) {
    messages.push({ role: "assistant", content });
  }

  return messages;
}

/**
 * Inject tool result blocks.
 */
export function injectToolResults(
  messages: LlmMessage[],
  results: Array<{ toolCallId: string; output: string }>,
): LlmMessage[] {
  for (const r of results) {
    messages.push({
      role: "tool",
      content: r.output,
      toolCallId: r.toolCallId,
    });
  }
  return messages;
}
