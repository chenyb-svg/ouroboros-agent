// =============================================================================
// Memory Retriever — Keyword-based retrieval with decay weighting
// Implements MemoryRetriever interface for future embedding swap.
// =============================================================================

import type { MemoryStorage } from "./storage.js";
import type { MemoryRetriever, MemoryEntity, MemoryCategory, MemoryQueryResult } from "../types/memory.js";

export class KeywordRetriever implements MemoryRetriever {
  private storage: MemoryStorage;

  constructor(storage: MemoryStorage) {
    this.storage = storage;
  }

  retrieve(
    query: string,
    topK: number = 5,
    categories?: MemoryCategory[],
  ): MemoryQueryResult[] {
    const entities = this.storage.query(query, topK * 3, categories);

    // Apply decay weighting for working memory
    const now = Date.now();
    const scored = entities.map((entity) => {
      let score = 1.0;

      // Keyword relevance (already scored by storage, normalize)
      score *= 1.0;

      // Recency decay: exponential decay with 7-day half-life
      const ageDays = (now - entity.timestamp) / (1000 * 60 * 60 * 24);
      const decayFactor = Math.exp(-0.1 * ageDays);
      score *= decayFactor;

      // Confidence weighting
      const confidenceWeights: Record<string, number> = {
        user_confirmed: 1.0,
        auto_high: 0.7,
        auto_medium: 0.4,
        auto_low: 0.2,
      };
      score *= confidenceWeights[entity.confidence] ?? 0.3;

      // Access frequency boost (up to 1.5x)
      score *= 1 + Math.min(entity.accessCount * 0.1, 0.5);

      return { entity, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Format retrieved memories for context injection */
  formatForContext(results: MemoryQueryResult[]): string {
    if (results.length === 0) return "";

    const lines = ["## Relevant Memories"];
    for (const r of results) {
      const conf = r.entity.confidence.replace("_", " ");
      const scope = r.entity.scope.startsWith("project") ? "project" : r.entity.scope.startsWith("session") ? "session" : "global";
      lines.push(`- [${conf}] [${scope}] ${r.entity.fact}`);
    }
    return lines.join("\n");
  }
}
