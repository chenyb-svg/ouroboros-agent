// =============================================================================
// SkillAdapter Interface — Pure interface, no implementation
// Adapters translate external ecosystem formats → standardized AgentContract
// =============================================================================

import type { AgentContract } from "../types/agents.js";

export interface SkillAdapter {
  /** Unique name of this adapter */
  readonly name: string;

  /** Does this adapter recognize the path? */
  canHandle(path: string): boolean;

  /** Parse the path into AgentContracts */
  parse(path: string): Promise<AgentContract[]>;

  /**
   * Set up file watching for this path.
   * Returns an unsubscribe function.
   * onChange is called with the new contracts when files change.
   */
  watch(
    path: string,
    onChange: (contracts: AgentContract[]) => void,
  ): () => void;
}
