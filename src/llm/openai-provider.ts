// =============================================================================
// OpenAI Provider — Wraps OpenAI SDK for DeepSeek (OpenAI-compatible API)
// Maps OpenAI stream events → standardized LlmChunk types
// =============================================================================

import OpenAI from "openai";
import type { LlmProvider } from "./provider.js";
import type {
  LlmCallParams,
  LlmChunk,
  LlmMessage,
  TextDeltaChunk,
  ToolUseStartChunk,
  ToolUseDeltaChunk,
  ToolUseStopChunk,
  UsageChunk,
} from "./types.js";
import { estimateTokenCount as heuristicCount } from "./token-counter.js";
import { sanitizeDeep } from "./sanitize.js";

export interface OpenAiProviderConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  models: string[];
}

export class OpenAiProvider implements LlmProvider {
  readonly name: string;
  readonly models: string[];
  private client: OpenAI;

  constructor(config: OpenAiProviderConfig) {
    this.name = config.name;
    this.models = config.models;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  async *call(params: LlmCallParams): AsyncGenerator<LlmChunk> {
    const model = this.models[0] ?? "deepseek-v4-flash";

    // Convert internal messages to OpenAI format
    const messages = convertToOpenAiMessages(params.messages, params.systemPrompt);

    // Convert tools
    const tools = params.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      },
    }));

    // Tool choice
    let toolChoice: "auto" | "required" | "none" | undefined;
    switch (params.toolChoice) {
      case "any": toolChoice = "required"; break;
      case "none": toolChoice = "none"; break;
      default: toolChoice = "auto";
    }

    // Call OpenAI streaming API
    // DeepSeek: disable thinking when tools are used (thinking mode conflicts with tool_calls)
    const requestBody: Record<string, unknown> = {
      model,
      messages,
      tools,
      tool_choice: toolChoice,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 8192,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (tools && tools.length > 0) {
      requestBody["thinking"] = { type: "disabled" };
    }

    // Boundary guard: no string in the outbound body may carry a lone UTF-16
    // surrogate — DeepSeek/Anthropic parse the body with serde_json, which
    // rejects an unpaired surrogate escape as "unexpected end of hex escape"
    // (400). Scrub every string so that class of error can never reach the API.
    // The scrub log doubles as a diagnostic: when a lone surrogate IS found, its
    // snippet points at the exact prompt/truncation site that produced it.
    const clean = sanitizeDeep(requestBody);
    if (clean.fixed > 0) {
      console.error(`[llm-sanitize] scrubbed ${clean.fixed} string(s) with lone surrogate(s) from the request body before send:`);
      for (const smp of clean.samples) console.error(`  ${smp}`);
    }

    const stream = await this.client.chat.completions.create(clean.value as any);

    // State machine for accumulating tool calls
    let chunkIndex = 0;
    const toolCallsAccumulator = new Map<
      number,
      { id: string; name: string; args: string }
    >();

    for await (const chunk of stream as any) {
      const delta = chunk.choices?.[0]?.delta;
      const finishReason = chunk.choices?.[0]?.finish_reason;
      const usage = chunk.usage;

      // ---- Text delta ----
      if (delta?.content) {
        yield {
          type: "text_delta",
          delta: delta.content,
          index: chunkIndex++,
        } as TextDeltaChunk;
      }

      // ---- Tool call delta ----
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;

          if (!toolCallsAccumulator.has(idx)) {
            toolCallsAccumulator.set(idx, { id: "", name: "", args: "" });
          }
          const acc = toolCallsAccumulator.get(idx)!;

          if (tc.id && !acc.id) {
            acc.id = tc.id;
            acc.name = tc.function?.name ?? "unknown";
            yield {
              type: "tool_use_start",
              id: acc.id,
              name: acc.name,
              index: idx,
            } as ToolUseStartChunk;
          }

          if (tc.function?.arguments) {
            acc.args += tc.function.arguments;
            yield {
              type: "tool_use_delta",
              id: acc.id || `tool-${idx}`,
              delta: tc.function.arguments,
            } as ToolUseDeltaChunk;
          }
        }
      }

      // ---- Tool use stop ----
      if (finishReason === "tool_calls" || finishReason === "stop") {
        for (const [, acc] of toolCallsAccumulator) {
          if (acc.id) {
            let parsedArgs: Record<string, unknown> | undefined;
            try { parsedArgs = JSON.parse(acc.args); } catch { parsedArgs = undefined; }

            yield {
              type: "tool_use_stop",
              id: acc.id,
              name: acc.name,
              rawArgs: acc.args,
              parsedArgs,
            } as ToolUseStopChunk;
          }
        }
      }

      // ---- Usage ----
      if (usage) {
        yield {
          type: "usage",
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        } as UsageChunk;
      }
    }
  }

  estimateTokenCount(
    messages: LlmMessage[],
    systemPrompt?: string,
    tools?: LlmCallParams["tools"],
  ): number {
    return heuristicCount(messages, systemPrompt, tools);
  }
}

// ---- Helpers ------------------------------------------------------------

function convertToOpenAiMessages(
  messages: LlmMessage[],
  systemPrompt?: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  // System prompt as first message
  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        result.push({ role: "system", content: msg.content as string });
        break;

      case "user":
        result.push({ role: "user", content: msg.content as string });
        break;

      case "assistant":
        if (typeof msg.content === "string") {
          const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;
          const assistantMsg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
            role: "assistant",
            // DeepSeek: when tool_calls are present, content must be empty/null
            content: hasToolCalls ? "" : msg.content,
          };
          if (hasToolCalls) {
            (assistantMsg as any).tool_calls = msg.toolCalls;
          }
          result.push(assistantMsg);
        } else if (Array.isArray(msg.content)) {
          const textBlocks = msg.content
            .filter((b) => b.type === "text")
            .map((b) => (b as { text: string }).text)
            .join("\n");
          const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;

          const assistantMsg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
            role: "assistant",
            content: hasToolCalls ? "" : (textBlocks || null),
          };
          if (hasToolCalls) {
            (assistantMsg as any).tool_calls = msg.toolCalls;
          }
          result.push(assistantMsg);
        }
        break;

      case "tool":
        result.push({
          role: "tool",
          content: msg.content as string,
          tool_call_id: msg.toolCallId ?? "unknown",
        });
        break;
    }
  }

  return result;
}
