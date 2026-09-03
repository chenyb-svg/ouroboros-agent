// =============================================================================
// Ouroboros Renderer — Character grid & layout types
// =============================================================================

import type { ColorLevel } from "./config.js";

// ---- Cursor modes -----------------------------------------------------------

export type CursorMode = "stream" | "interactive" | "silent";

// ---- Layout primitives ------------------------------------------------------

/** A renderable unit that participates in the flexbox layout */
export interface RenderBox {
  id: string;
  minHeight: number;
  flexGrow: number;       // weight for distributing remaining space
  border: BorderStyle;
  content: string[];
  visible: boolean;
}

export interface BorderStyle {
  top: boolean;
  bottom: boolean;
  left: boolean;
  right: boolean;
  char: string;           // border character, e.g. "─" or "━"
}

/** The computed geometry after layout */
export interface BoxGeometry {
  id: string;
  y: number;              // row offset from top of content area
  height: number;         // allocated rows
  border: BorderStyle;
}

// ---- Dirty region tracking --------------------------------------------------

export interface DirtyRegion {
  y: number;              // starting row
  height: number;         // number of rows affected
}

// ---- Screen buffer ----------------------------------------------------------

export interface ScreenCell {
  char: string;
  fg: ColorValue | null;
  bg: ColorValue | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

export interface ColorValue {
  type: "named" | "256" | "truecolor";
  value: string;          // "red", "196", "#ff0000"
}

/** The complete character grid */
export interface ScreenBuffer {
  width: number;
  height: number;
  cells: ScreenCell[][];  // [row][col]
}

// ---- Theme ------------------------------------------------------------------

export interface RenderTheme {
  colorLevel: ColorLevel;
  variant: "dark" | "light";
  colors: {
    statusBarBg: ColorValue;
    statusBarFg: ColorValue;
    contentBg: ColorValue;
    contentFg: ColorValue;
    inputBarBg: ColorValue;
    inputBarFg: ColorValue;
    overlayBg: ColorValue;
    overlayFg: ColorValue;
    overlayDim: ColorValue;       // for dimming content behind overlay
    accent: ColorValue;
    error: ColorValue;
    warning: ColorValue;
    success: ColorValue;
    toolCall: ColorValue;
    codeBlock: ColorValue;
    dimmed: ColorValue;           // for muted/secondary text
  };
}

// ---- Rendering context ------------------------------------------------------

export interface RenderContext {
  terminalWidth: number;
  terminalHeight: number;
  contentHeight: number;          // height available for content (total - status bar - input bar)
  theme: RenderTheme;
  cursorMode: CursorMode;
  overlayVisible: boolean;
}

// ---- Layer IDs --------------------------------------------------------------

export type LayerId = "base" | "content" | "overlay";
