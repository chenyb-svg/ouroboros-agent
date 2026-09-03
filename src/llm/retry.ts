// =============================================================================
// LLM Retry Logic — Exponential backoff + error classification
// =============================================================================

import type { LlmError, LlmErrorKind } from "./types.js";

/**
 * Classify an error from an LLM provider into a standardized LlmError.
 */
export function classifyError(err: unknown): LlmError {
  // Handle OpenAI API errors
  if (err && typeof err === "object" && "status" in err) {
    const apiErr = err as { status: number; message?: string; code?: string };

    switch (apiErr.status) {
      case 429:
        return {
          kind: "transient",
          message: apiErr.message ?? "Rate limited",
          statusCode: 429,
          retryable: true,
          raw: err,
        };
      case 500:
      case 502:
      case 503:
      case 504:
        return {
          kind: "transient",
          message: apiErr.message ?? "Server error",
          statusCode: apiErr.status,
          retryable: true,
          raw: err,
        };
      case 402:
        return {
          kind: "balance",
          message: apiErr.message ?? "Insufficient balance",
          statusCode: 402,
          retryable: false,
          raw: err,
        };
      case 413:
        return {
          kind: "context",
          message: apiErr.message ?? "Context too large",
          statusCode: 413,
          retryable: false,
          raw: err,
        };
      case 400:
        return {
          kind: "content",
          message: apiErr.message ?? "Bad request",
          statusCode: 400,
          retryable: false,
          raw: err,
        };
      case 401:
      case 403:
        return {
          kind: "auth",
          message: apiErr.message ?? "Authentication failed",
          statusCode: apiErr.status,
          retryable: false,
          raw: err,
        };
    }
  }

  // Abort errors (user Ctrl+C) are never retryable — retrying after an abort
  // would immediately fail on the already-aborted signal.
  if (err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"))) {
    return { kind: "content", message: "Request aborted by user", retryable: false, raw: err };
  }

  // Network errors
  if (err instanceof Error) {
    const netErr = err as NodeJS.ErrnoException;
    if (
      netErr.code === "ECONNRESET" ||
      netErr.code === "ETIMEDOUT" ||
      netErr.code === "ECONNREFUSED" ||
      netErr.code === "ENOTFOUND" ||
      err.message.includes("fetch") ||
      err.message.includes("network") ||
      err.message.includes("timeout")
    ) {
      return {
        kind: "transient",
        message: err.message,
        retryable: true,
        raw: err,
      };
    }
  }

  // Message-based fallbacks — some providers throw plain Errors with the HTTP
  // status embedded in the message string (no `status` property).
  if (err instanceof Error || typeof err === "string") {
    const msg = err instanceof Error ? err.message : String(err);
    const m = msg.toLowerCase();
    if (msg.includes("401") || msg.includes("403") || m.includes("invalid api key") || m.includes("authentication")) {
      return { kind: "auth", message: msg, retryable: false, raw: err };
    }
    // 402 / insufficient funds → fatal, surface to the user instead of retrying
    // (DeepSeek returns 402 Insufficient Balance when the account runs out).
    if (msg.includes("402") || m.includes("insufficient") || msg.includes("余额")) {
      return { kind: "balance", message: msg, retryable: false, raw: err };
    }
    if (msg.includes("413") || m.includes("context length") || m.includes("maximum context") || m.includes("context too long")) {
      return { kind: "context", message: msg, retryable: false, raw: err };
    }
    if (msg.includes("400") || m.includes("bad request") || m.includes("invalid request") || m.includes("content filter")) {
      return { kind: "content", message: msg, retryable: false, raw: err };
    }
    if (msg.includes("429") || m.includes("rate limit") || /50[0-9]/.test(msg)) {
      return { kind: "transient", message: msg, retryable: true, raw: err };
    }
  }

  // Unknown — transient (a single retry rarely hurts; the caller caps attempts)
  return {
    kind: "transient",
    message: err instanceof Error ? err.message : String(err),
    retryable: true,
    raw: err,
  };
}

/**
 * Sleep for ms milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000; // 1s → 2s → 4s

/**
 * Retry a function with exponential backoff.
 * Only retries on transient errors.
 *
 * Returns the result on success, or throws the last LlmError on failure.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  onRetry?: (attempt: number, delayMs: number, error: LlmError) => void,
): Promise<T> {
  let lastError: LlmError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const classified = classifyError(err);

      if (!classified.retryable || attempt >= MAX_RETRIES) {
        throw classified;
      }

      lastError = classified;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);

      if (onRetry) {
        onRetry(attempt + 1, delay, classified);
      }

      await sleep(delay);
    }
  }

  // Unreachable but satisfy TypeScript
  throw lastError ?? new Error("Retry failed");
}
