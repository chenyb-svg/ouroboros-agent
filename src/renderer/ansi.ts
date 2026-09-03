// =============================================================================
// ANSI Escape Sequence Builders — The only module that knows ANSI codes
// =============================================================================

import type { ColorValue } from "../types/renderer.js";
import type { ColorLevel } from "../types/config.js";

// ---- Cursor movement -------------------------------------------------------

export function cursorTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

export function cursorUp(n: number): string {
  return `\x1b[${n}A`;
}

export function cursorDown(n: number): string {
  return `\x1b[${n}B`;
}

export function cursorForward(n: number): string {
  return `\x1b[${n}C`;
}

export function cursorBack(n: number): string {
  return `\x1b[${n}D`;
}

export function cursorHide(): string {
  return "\x1b[?25l";
}

export function cursorShow(): string {
  return "\x1b[?25h";
}

export function cursorSave(): string {
  return "\x1b[s";
}

export function cursorRestore(): string {
  return "\x1b[u";
}

// ---- Screen clearing -------------------------------------------------------

export function clearScreen(): string {
  return "\x1b[2J";
}

export function clearLine(): string {
  return "\x1b[2K";
}

export function clearToEnd(): string {
  return "\x1b[0J";
}

export function clearToBeginning(): string {
  return "\x1b[1J";
}

// ---- Colors ----------------------------------------------------------------

/**
 * Build an SGR (Select Graphic Rendition) sequence for a screen cell's styling.
 * Returns "" if no styling is needed (cell is "empty").
 */
export function sgr(params: {
  fg: ColorValue | null;
  bg: ColorValue | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}, colorLevel: ColorLevel): string {
  const codes: number[] = [];

  // Reset first
  codes.push(0);

  // Foreground
  if (params.fg) {
    const fgCodes = colorToSgr(params.fg, false, colorLevel);
    codes.push(...fgCodes);
  }

  // Background
  if (params.bg) {
    const bgCodes = colorToSgr(params.bg, true, colorLevel);
    codes.push(...bgCodes);
  }

  // Styles
  if (params.bold) codes.push(1);
  if (params.italic) codes.push(3);
  if (params.underline) codes.push(4);

  if (codes.length === 1) return ""; // only reset, nothing to style
  return `\x1b[${codes.join(";")}m`;
}

export function resetSgr(): string {
  return "\x1b[0m";
}

function colorToSgr(color: ColorValue, isBg: boolean, colorLevel: ColorLevel): number[] {
  const base = isBg ? 10 : 0;

  if (color.type === "named") {
    const code = namedColorCode(color.value);
    if (code !== null) return [code + base];
    // Unknown named color, fall through to default
    return [];
  }

  if (color.type === "256" || (colorLevel === 256 && color.type === "truecolor")) {
    const code = parseInt(color.value, 10);
    if (!isNaN(code) && code >= 0 && code < 256) {
      return [isBg ? 48 : 38, 5, code];
    }
    return [];
  }

  if (color.type === "truecolor" && colorLevel === "truecolor") {
    const hex = color.value.replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
      return [isBg ? 48 : 38, 2, r, g, b];
    }
    return [];
  }

  return [];
}

function namedColorCode(name: string): number | null {
  const colors: Record<string, number> = {
    black: 30, red: 31, green: 32, yellow: 33,
    blue: 34, magenta: 35, cyan: 36, white: 37,
    brightBlack: 90, brightRed: 91, brightGreen: 92, brightYellow: 93,
    brightBlue: 94, brightMagenta: 95, brightCyan: 96, brightWhite: 97,
  };
  return colors[name] ?? null;
}

// ---- Terminal title (OSC) --------------------------------------------------

export function setTitle(title: string): string {
  return `\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, "")}\x07`;
}

// ---- Misc ------------------------------------------------------------------

export function alternateScreen(): string {
  return "\x1b[?1049h";
}

export function normalScreen(): string {
  return "\x1b[?1049l";
}

/** OSC 8 hyperlink */
export function hyperlink(uri: string, text: string): string {
  return `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;
}
