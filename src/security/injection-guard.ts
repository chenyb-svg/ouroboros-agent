// =============================================================================
// Prompt-injection protection (P1)
// External content (web fetch results, search results, chat messages, files read
// from outside the workspace) is wrapped in a [UNTRUSTED] boundary and scanned
// for classic injection fingerprints before it enters the model context.
// =============================================================================

export type PromptInjectionMode = "tag" | "strip" | "off";

// Runtime mode — set once at startup from config `security.promptInjection`.
let currentMode: PromptInjectionMode = "tag";
export function setInjectionMode(mode: PromptInjectionMode): void { currentMode = mode; }
export function getInjectionMode(): PromptInjectionMode { return currentMode; }

export const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /ignore\s+(all\s+)?(prior|previous|above|earlier)\s+(instructions|messages|text|prompts)/i, label: "ignore-prior-instructions" },
  { pattern: /disregard\s+(all\s+)?(prior|previous|above|earlier)\s+(instructions|rules|messages)/i, label: "disregard-prior" },
  { pattern: /forget\s+(all\s+)?(prior|previous|above)\s+(instructions|rules)/i, label: "forget-prior" },
  { pattern: /you\s+are\s+now(\s+(an?|the))?\s/i, label: "you-are-now" },
  { pattern: /system\s*prompt/i, label: "system-prompt-reference" },
  { pattern: /reveal\s+(your|the\s+system)/i, label: "reveal-your" },
  { pattern: /print\s+(out\s+)?your\s+(full\s+)?(system\s+)?prompt/i, label: "print-prompt" },
  { pattern: /show\s+(me\s+)?your\s+(full\s+)?(system\s+)?prompt/i, label: "show-prompt" },
  { pattern: /<script[\s>]/i, label: "script-tag" },
  { pattern: /act\s+as\s+(an?\s+)?/i, label: "act-as" },
  { pattern: /new\s+system\s+message/i, label: "new-system-message" },
  { pattern: /start\s+with\s+["']/i, label: "start-with-quote" },
  { pattern: /repeat\s+(after\s+me|the\s+words\s+above|this\s+exactly)/i, label: "repeat-after-me" },
];

// Long base64 / hex blobs are a common exfiltration obfuscation marker.
const LONG_B64 = /[A-Za-z0-9+/]{64,}={0,2}/;
const LONG_HEX = /[0-9a-fA-F]{64,}/;

/** Return the labels of all injection fingerprints found in `content`. */
export function detectInjection(content: string): string[] {
  const hits: string[] = [];
  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(content)) hits.push(label);
  }
  if (LONG_B64.test(content)) hits.push("long-base64");
  if (LONG_HEX.test(content)) hits.push("long-hex");
  return hits;
}

const MAX_KEPT_CHARS = 4000;

/**
 * Sanitize untrusted external content before it enters the model context.
 * - "tag": wrap in [UNTRUSTED (source)] boundary; on injection hit, truncate + warn.
 * - "strip": on injection hit, drop the content entirely, keep only the warning.
 * - "off": passthrough.
 */
export function sanitizeExternal(
  content: string,
  source: string,
  mode: PromptInjectionMode = currentMode,
): string {
  if (mode === "off") return content;

  const truncated =
    content.length > MAX_KEPT_CHARS
      ? content.slice(0, MAX_KEPT_CHARS) + `\n... [truncated ${content.length - MAX_KEPT_CHARS} chars]`
      : content;

  const hits = detectInjection(truncated);

  if (hits.length === 0) {
    return `[UNTRUSTED (${source})]\n${truncated}\n[/UNTRUSTED]`;
  }

  const warning = `⚠️ [Prompt-injection attempt suspected in ${source}; content stripped] (signals: ${hits.join(", ")})`;

  if (mode === "strip") {
    return `[UNTRUSTED (${source})]\n${warning}\n[/UNTRUSTED]`;
  }

  return `[UNTRUSTED (${source})]\n${truncated}\n${warning}\n[/UNTRUSTED]`;
}
