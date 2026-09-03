// =============================================================================
// Compaction Cache — Cache control point tracking for prompt caching (Phase 4)
// =============================================================================

export type CachePointType = "system_prompt" | "tool_definitions" | "recent_messages";

interface CachePoint {
  index: number;
  type: CachePointType;
  protected: boolean;
}

export class CompactionCache {
  private points: CachePoint[] = [];

  /** Mark a message index as a cache control point */
  mark(index: number, type: CachePointType): void {
    // Remove any existing point at this index
    this.points = this.points.filter((p) => p.index !== index);
    this.points.push({ index, type, protected: true });
    this.points.sort((a, b) => a.index - b.index);
  }

  /** Check if a message index can be removed by compression */
  canRemove(index: number): boolean {
    const point = this.points.find((p) => p.index === index);
    return !point?.protected;
  }

  /** Get all protected indices */
  protectedIndices(): number[] {
    return this.points.filter((p) => p.protected).map((p) => p.index);
  }

  /** Get the nearest protected point before an index */
  nearestProtectedBefore(index: number): number {
    const before = this.points.filter((p) => p.protected && p.index < index);
    if (before.length === 0) return -1;
    return before[before.length - 1].index;
  }

  /** Clear all points */
  clear(): void {
    this.points = [];
  }

  /** Get cache point summary for logging */
  summary(): string {
    return this.points
      .filter((p) => p.protected)
      .map((p) => `[${p.index}]:${p.type}`)
      .join(", ");
  }
}
