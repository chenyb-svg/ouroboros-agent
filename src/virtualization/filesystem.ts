// =============================================================================
// Filesystem Virtualization Layer — Shadow writes, read tracking (Phase 4)
// =============================================================================

import { readFile, writeFile, mkdir, readdir, stat, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, normalize } from "node:path";

export interface FsVirtualization {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, agentId?: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number; isDirectory: boolean }>;

  // Phase 4 additions
  /** Track which files each agent has read */
  getReadsByAgent(agentId: string): string[];
  /** Get all pending shadow writes */
  getShadowWrites(): Map<string, { content: string; agentId: string; timestamp: number }>;
  /** Commit all shadow writes to real filesystem */
  commitWrites(): Promise<string[]>;
  /** Rollback (discard) specific shadow writes */
  rollbackWrites(paths: string[]): void;
  /** Detect conflicts: two agents writing to same file */
  detectConflicts(): Array<{ path: string; agents: string[] }>;
  /** Validate path (no traversal above workspace root) */
  resolvePath(path: string, workspaceRoot: string): string | null;
}

export class VirtualFileSystem implements FsVirtualization {
  private workspaceRoot: string;
  private readsByAgent = new Map<string, Set<string>>();
  private shadowWrites = new Map<string, { content: string; agentId: string; timestamp: number }>();
  private fileVersions = new Map<string, number>();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
  }

  async readFile(path: string): Promise<string> {
    const resolved = this.resolvePath(path, this.workspaceRoot);
    if (!resolved) throw new Error(`Path traversal denied: ${path}`);
    return readFile(resolved, "utf-8");
  }

  async writeFile(path: string, content: string, agentId?: string): Promise<void> {
    const resolved = this.resolvePath(path, this.workspaceRoot);
    if (!resolved) throw new Error(`Path traversal denied: ${path}`);

    // Shadow write: buffer in memory
    this.shadowWrites.set(resolved, {
      content,
      agentId: agentId ?? "unknown",
      timestamp: Date.now(),
    });

    // Bump version
    const currentVersion = this.fileVersions.get(resolved) ?? 0;
    this.fileVersions.set(resolved, currentVersion + 1);
  }

  async mkdir(path: string): Promise<void> {
    const resolved = this.resolvePath(path, this.workspaceRoot);
    if (!resolved) throw new Error(`Path traversal denied: ${path}`);
    await mkdir(resolved, { recursive: true });
  }

  async readdir(path: string): Promise<string[]> {
    const resolved = this.resolvePath(path, this.workspaceRoot);
    if (!resolved) throw new Error(`Path traversal denied: ${path}`);
    return readdir(resolved);
  }

  async exists(path: string): Promise<boolean> {
    const resolved = this.resolvePath(path, this.workspaceRoot);
    if (!resolved) return false;
    try {
      await access(resolved, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<{ size: number; isDirectory: boolean }> {
    const resolved = this.resolvePath(path, this.workspaceRoot);
    if (!resolved) throw new Error(`Path traversal denied: ${path}`);
    const s = await stat(resolved);
    return { size: s.size, isDirectory: s.isDirectory() };
  }

  // ---- Phase 4: Shadow writes + read tracking ----

  trackRead(agentId: string, path: string): void {
    if (!this.readsByAgent.has(agentId)) {
      this.readsByAgent.set(agentId, new Set());
    }
    this.readsByAgent.get(agentId)!.add(path);
  }

  getReadsByAgent(agentId: string): string[] {
    return [...(this.readsByAgent.get(agentId) ?? new Set())];
  }

  getShadowWrites(): Map<string, { content: string; agentId: string; timestamp: number }> {
    return new Map(this.shadowWrites);
  }

  async commitWrites(): Promise<string[]> {
    const committed: string[] = [];
    for (const [path, shadow] of this.shadowWrites) {
      await writeFile(path, shadow.content, "utf-8");
      committed.push(path);
    }
    this.shadowWrites.clear();
    return committed;
  }

  rollbackWrites(paths: string[]): void {
    for (const path of paths) {
      this.shadowWrites.delete(path);
    }
  }

  detectConflicts(): Array<{ path: string; agents: string[] }> {
    const conflicts: Array<{ path: string; agents: string[] }> = [];
    const pathToAgents = new Map<string, string[]>();

    for (const [path, shadow] of this.shadowWrites) {
      const agents = pathToAgents.get(path) ?? [];
      agents.push(shadow.agentId);
      pathToAgents.set(path, agents);
    }

    for (const [path, agents] of pathToAgents) {
      if (agents.length > 1) {
        conflicts.push({ path, agents: [...new Set(agents)] });
      }
    }

    return conflicts;
  }

  resolvePath(path: string, _workspaceRoot: string): string | null {
    const normalized = normalize(path);
    // Reject absolute paths that go above workspace
    if (normalized.startsWith("..")) return null;
    // Reject paths with .. that escape
    if (normalized.includes("..")) {
      // Allow .. within workspace boundaries
      const resolved = resolve(this.workspaceRoot, normalized);
      if (!resolved.startsWith(this.workspaceRoot)) return null;
      return resolved;
    }
    return resolve(this.workspaceRoot, normalized);
  }
}

/** Singleton passthrough for legacy compatibility */
export const realFs: VirtualFileSystem = new VirtualFileSystem(process.cwd());

// ---- Phase 5: Secret Redaction -----------------------------------------------

const SECRET_PATTERNS = [
  /(["']?(?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["'])([^"']+)(["'])/gi,
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
  /sk-[a-zA-Z0-9]{32,}/g,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /github_pat_[a-zA-Z0-9_]{40,}/g,
];

/**
 * Redact known secret patterns from content.
 * Replaces matched secrets with [REDACTED].
 */
export function redactSecrets(content: string): string {
  let result = content;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, prefix?: string, secret?: string, suffix?: string) => {
      if (prefix && suffix) {
        return `${prefix}[REDACTED]${suffix}`;
      }
      return "[REDACTED]";
    });
  }
  return result;
}
