// =============================================================================
// Ouroboros Skill Registry Types — Adapter interface & skill discovery
// =============================================================================

import type { AgentContract } from "./agents.js";

// ---- Skill Source -----------------------------------------------------------

export type SkillSource = "builtin" | "user" | "project" | "import";

// ---- Skill Manifest ---------------------------------------------------------

export interface SkillManifest {
  /** File path this skill was loaded from */
  path: string;
  /** Which adapter parsed it */
  adapter: string;
  /** Source level */
  source: SkillSource;
  /** The standardized agent contract */
  contract: AgentContract;
  /** Timestamp when loaded */
  loadedAt: number;
  /** Whether there were non-fatal warnings during loading */
  warnings: string[];
}

// ---- Skill Import Config ----------------------------------------------------

export interface SkillImport {
  /** Directory path to scan */
  path: string;
  /** Adapter to use: "claude-code" | "openclaw" | "mcp" */
  adapter: string;
  /** Optional namespace prefix for all skills from this import */
  namespace?: string;
  /** Loading priority (higher = loaded first, wins conflicts) */
  priority: number;
}

// ---- Skill Adapter Interface ------------------------------------------------

export interface SkillAdapter {
  /** Unique name of this adapter */
  readonly name: string;
  /** Does this adapter recognize the path? */
  canHandle(path: string): boolean;
  /** Parse the path into AgentContracts */
  parse(path: string): Promise<AgentContract[]>;
  /** Set up file watching for this path. onChange called with new contracts. */
  watch(path: string, onChange: (contracts: AgentContract[]) => void): () => void;
}
