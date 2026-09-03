// =============================================================================
// Ouroboros Memory Types — Structured knowledge persistence (Phase 4)
// =============================================================================

export type MemoryCategory =
  | "coding_style"
  | "project_setup"
  | "user_preference"
  | "constraint"
  | "correction"
  | "architecture"
  | "tool_usage"
  | "general";

export type MemoryScope = "global" | `project:${string}` | `session:${string}`;

export type ConfidenceLevel =
  | "auto_low"
  | "auto_medium"
  | "auto_high"
  | "user_confirmed";

export interface MemoryEntity {
  id: string;
  fact: string;
  category: MemoryCategory;
  scope: MemoryScope;
  source: {
    agentId: string;
    sessionId: string;
    messageId?: string;
  };
  confidence: ConfidenceLevel;
  timestamp: number;
  accessCount: number;
  lastAccessed: number;
  /** Negative facts for conflict resolution */
  negativeFacts?: string[];
  /** TTL in ms (only for working memory) */
  ttl?: number;
}

export interface MemoryQueryResult {
  entity: MemoryEntity;
  score: number;
  source?: string;
  conflictingEntities?: MemoryEntity[];
}

/** Pluggable retriever interface for future embedding/vector DB swap */
export interface MemoryRetriever {
  retrieve(
    query: string,
    topK: number,
    categories?: MemoryCategory[],
  ): MemoryQueryResult[];

  /** Invalidate cached embeddings (for hot-reload) */
  invalidate?(): void;
}
