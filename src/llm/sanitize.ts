// =============================================================================
// Lone-surrogate sanitizer — kills the "400 unexpected end of hex escape" class
// =============================================================================
//
// DeepSeek (and Anthropic via its OpenAI-compatible endpoint) parse the request
// body with serde_json, which REJECTS a *lone* UTF-16 surrogate: on a high
// surrogate escape like \ud83d it requires an immediately-following low surrogate
// and errors ("unexpected end of hex escape") the moment the string ends or the
// next char isn't the expected \uDCxx. JS strings can legitimately hold lone
// surrogates — a .slice() boundary that lands mid-emoji, a half-decoded byte
// stream, pasted text from a truncated clipboard, model output… — so every string
// that crosses the LLM outbound boundary must be scrubbed. We replace unpaired
// surrogates with U+FFFD (a single valid BMP char the API accepts) and never emit
// a broken escape again.
// =============================================================================

export interface SanitizeResult {
  /** The input with all lone surrogates replaced by U+FFFD (objects are rebuilt). */
  value: unknown;
  /** How many strings were modified (for logging). */
  fixed: number;
  /** Short context snippets of up to the first `fixed` fixes, for root-causing. */
  samples: string[];
}

const MAX_SAMPLES = 2;
/** U+FFFD replacement character, kept as an escape so the source never depends on
 *  how an editor re-encodes a literal astral glyph. */
const FFFD = "�";

/** Replace unpaired surrogate code units in `s` with U+FFFD. Valid surrogate
 *  pairs (a real emoji / astral char) are preserved verbatim. Cheap no-op when
 *  the string contains no surrogate at all. */
export function sanitizeString(s: string): string {
  const n = s.length;
  let i = 0;
  // Scan ahead to the first lone surrogate (valid pairs skipped in pairs).
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) { i += 2; continue; }
      break; // lone high surrogate at i
    }
    if (c >= 0xdc00 && c <= 0xdfff) break; // lone low surrogate at i
    i += 1;
  }
  if (i >= n) return s;
  const parts: string[] = [s.slice(0, i)];
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) { parts.push(s.slice(i, i + 2)); i += 2; continue; }
      parts.push(FFFD); i += 1; continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) { parts.push(FFFD); i += 1; continue; }
    const start = i;
    while (i < n) {
      const c2 = s.charCodeAt(i);
      if (c2 >= 0xd800 && c2 <= 0xdfff) break;
      i += 1;
    }
    parts.push(s.slice(start, i));
  }
  return parts.join("");
}

/** Recurse over an outbound request body and scrub every string it contains. */
export function sanitizeDeep(v: unknown): SanitizeResult {
  let fixed = 0;
  const samples: string[] = [];

  function fixStr(s: string): string {
    const clean = sanitizeString(s);
    if (clean !== s) {
      fixed++;
      if (samples.length < MAX_SAMPLES) {
        // Show the bytes around the first divergence (which is the first lone
        // surrogate; the original may hold more after it).
        let diff = 0;
        const m = Math.min(s.length, clean.length);
        while (diff < m && s.charCodeAt(diff) === clean.charCodeAt(diff)) diff++;
        const a = Math.max(0, diff - 12);
        const snippet = JSON.stringify(s.slice(a, diff + 24));
        samples.push("..." + snippet + "...");
      }
    }
    return clean;
  }

  function walk(x: unknown): unknown {
    if (typeof x === "string") return fixStr(x);
    if (Array.isArray(x)) {
      const out = new Array(x.length);
      for (let i = 0; i < x.length; i++) out[i] = walk(x[i]);
      return out;
    }
    if (x && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x)) out[k] = walk((x as Record<string, unknown>)[k]);
      return out;
    }
    return x;
  }

  return { value: walk(v), fixed, samples };
}

/** UTF-16-safe slice: never ends on a high surrogate whose low partner was cut
 *  off, and never starts on a low surrogate whose high partner was cut off. The
 *  result is always surrogate-pair-clean (no lone surrogates can be introduced),
 *  so prompt-truncation sites can use it without re-poisoning the request. */
export function slicePairSafe(s: string, start: number, end?: number): string {
  const n = s.length;
  let st = Math.max(0, Math.min(start, n));
  let en = end === undefined ? n : Math.max(st, Math.min(end, n));
  // Ending boundary: if the last unit kept is a high surrogate, its low partner
  // was excluded → drop the dangling high so no lone surrogate is emitted.
  if (en > st) {
    const c = s.charCodeAt(en - 1);
    if (c >= 0xd800 && c <= 0xdbff) en--;
  }
  // Starting boundary: if the first unit kept is a low surrogate, its high
  // partner was excluded → skip past it.
  if (st < en) {
    const c = s.charCodeAt(st);
    if (c >= 0xdc00 && c <= 0xdfff) st++;
  }
  return s.slice(st, en);
}
