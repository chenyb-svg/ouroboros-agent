// =============================================================================
// JIT Permissions — Time-limited signed permission tokens (Phase 6)
// =============================================================================

import { randomUUID, createHmac } from "node:crypto";
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataPath } from "../data-home.js";

export type PermissionScope = "one-shot" | "session" | "persistent";

export interface JitToken {
  tokenId: string;
  agentId: string;
  tool: string;
  reason: string;
  scope: PermissionScope;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export class JitPermissionManager {
  private tokens = new Map<string, JitToken>();
  private secret: string;
  private tokensPath: string;

  constructor() {
    this.secret = process.env["OUROBOROS_JIT_SECRET"] ?? `jit-${randomUUID()}`;
    const permDir = dataPath("permissions");
    if (!existsSync(permDir)) mkdirSync(permDir, { recursive: true });
    this.tokensPath = join(permDir, "tokens.jsonl");
    this.loadTokens();
  }

  /** Request a JIT permission token */
  request(
    agentId: string,
    tool: string,
    reason: string,
    scope: PermissionScope = "one-shot",
    ttlMs?: number,
  ): JitToken {
    const ttl = ttlMs ?? (scope === "one-shot" ? 60_000 : scope === "session" ? 3_600_000 : 86_400_000);
    const token: Omit<JitToken, "signature"> = {
      tokenId: `jit-${randomUUID().slice(0, 8)}`,
      agentId,
      tool,
      reason,
      scope,
      issuedAt: Date.now(),
      expiresAt: Date.now() + ttl,
    };

    const signature = this.sign(token);
    const fullToken: JitToken = { ...token, signature };
    this.tokens.set(fullToken.tokenId, fullToken);
    this.persistToken(fullToken);

    return fullToken;
  }

  /** Validate a JIT token */
  validate(tokenId: string, tool: string): { valid: boolean; reason?: string } {
    const token = this.tokens.get(tokenId);
    if (!token) return { valid: false, reason: "Token not found" };

    // Verify signature
    const { signature, ...payload } = token;
    const expectedSig = this.sign(payload);
    if (signature !== expectedSig) {
      return { valid: false, reason: "Token signature invalid (tampered)" };
    }

    // Check expiry
    if (Date.now() > token.expiresAt) {
      this.tokens.delete(tokenId);
      return { valid: false, reason: `Token expired at ${new Date(token.expiresAt).toISOString()}` };
    }

    // Check tool match (exact or wildcard)
    if (token.tool !== "*" && token.tool !== tool) {
      return { valid: false, reason: `Token scoped to ${token.tool}, not ${tool}` };
    }

    // One-shot: auto-expire after first use
    if (token.scope === "one-shot") {
      this.tokens.delete(tokenId);
    }

    return { valid: true };
  }

  /** Revoke a token */
  revoke(tokenId: string): boolean {
    return this.tokens.delete(tokenId);
  }

  /** List active tokens */
  listActive(): JitToken[] {
    const now = Date.now();
    return [...this.tokens.values()].filter((t) => t.expiresAt > now);
  }

  private sign(payload: Omit<JitToken, "signature">): string {
    const data = `${payload.tokenId}:${payload.agentId}:${payload.tool}:${payload.issuedAt}:${payload.expiresAt}`;
    return createHmac("sha256", this.secret).update(data).digest("hex").slice(0, 32);
  }

  private persistToken(token: JitToken): void {
    try {
      appendFileSync(this.tokensPath, JSON.stringify(token) + "\n", "utf-8");
    } catch { /* non-critical */ }
  }

  private loadTokens(): void {
    if (!existsSync(this.tokensPath)) return;
    try {
      const raw = readFileSync(this.tokensPath, "utf-8");
      for (const line of raw.split("\n").filter((l) => l.trim())) {
        try {
          const token = JSON.parse(line) as JitToken;
          if (token.expiresAt > Date.now()) {
            this.tokens.set(token.tokenId, token);
          }
        } catch { /* skip invalid */ }
      }
    } catch { /* */ }
  }
}
