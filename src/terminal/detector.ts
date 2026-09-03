// =============================================================================
// Terminal Capability Detector — The "device driver" abstraction
// Must complete within 50ms of startup. Decision is locked for the session.
// =============================================================================

import type { ColorLevel } from "../types/config.js";
import type { TerminalResizeEvent } from "../types/events.js";

export interface TerminalCapabilities {
  /** True if this is an interactive terminal session */
  isTTY: boolean;
  /** True if running in a CI environment */
  isCI: boolean;
  /** True if stdin is being piped */
  isPipedInput: boolean;
  /** True if stdout is being redirected */
  isPipedOutput: boolean;
  /** Detected color level (never changes during session) */
  colorLevel: ColorLevel;
  /** Current terminal width (columns) */
  width: number;
  /** Current terminal height (rows) */
  height: number;
  /** Raw terminfo TERM value */
  term: string;
  /** Raw COLORTERM value */
  colorTerm: string | undefined;
}

let capabilities: TerminalCapabilities | null = null;
let resizeHandlers: Array<(caps: TerminalCapabilities) => void> = [];

/**
 * Probe the terminal once. Result is cached for the session lifetime.
 * Must be called before any rendering occurs.
 */
export function detectCapabilities(): TerminalCapabilities {
  if (capabilities) return capabilities;

  const isTTY = (process.stdout.isTTY && process.stdin.isTTY) ?? false;
  const isPipedInput = !process.stdin.isTTY;
  const isPipedOutput = !process.stdout.isTTY;
  const isCI = !!(
    process.env["CI"] ||
    process.env["GITHUB_ACTIONS"] ||
    process.env["GITLAB_CI"] ||
    process.env["JENKINS_URL"]
  );

  const term = process.env["TERM"] ?? "dumb";
  const colorTerm = process.env["COLORTERM"];

  const colorLevel = detectColorLevel();

  const [width, height] = getDimensions();

  capabilities = {
    isTTY,
    isCI,
    isPipedInput,
    isPipedOutput,
    colorLevel,
    width,
    height,
    term,
    colorTerm,
  };

  return capabilities;
}

function detectColorLevel(): ColorLevel {
  // NO_COLOR takes highest priority
  if (process.env["NO_COLOR"] !== undefined) {
    return 16;
  }

  const colorTerm = process.env["COLORTERM"];
  if (colorTerm === "truecolor" || colorTerm === "24bit") {
    return "truecolor";
  }

  const term = process.env["TERM"] ?? "";
  if (term.includes("256color")) {
    return 256;
  }

  // Default: basic 16-color support
  return 16;
}

function getDimensions(): [number, number] {
  return [
    process.stdout.columns ?? 80,
    process.stdout.rows ?? 24,
  ];
}

/**
 * Update dimensions (called on SIGWINCH and also periodically).
 * Returns true if dimensions actually changed.
 */
export function refreshDimensions(): boolean {
  if (!capabilities) return false;

  const [w, h] = getDimensions();
  if (w !== capabilities.width || h !== capabilities.height) {
    capabilities.width = w;
    capabilities.height = h;
    for (const handler of resizeHandlers) {
      handler(capabilities);
    }
    return true;
  }
  return false;
}

export function onResize(handler: (caps: TerminalCapabilities) => void): () => void {
  resizeHandlers.push(handler);
  return () => {
    resizeHandlers = resizeHandlers.filter((h) => h !== handler);
  };
}

export function getCapabilities(): TerminalCapabilities {
  if (!capabilities) {
    return detectCapabilities();
  }
  return capabilities;
}

/**
 * Build a TERMINAL_RESIZE event payload
 */
export function buildResizeEvent(
  caps: TerminalCapabilities,
  eventId: string,
  sessionId: string,
  causalChainId: string,
): TerminalResizeEvent {
  return {
    eventId,
    type: "TERMINAL_RESIZE",
    timestamp: performance.now(),
    sessionId,
    causalChainId,
    payload: {
      width: caps.width,
      height: caps.height,
    },
  };
}
