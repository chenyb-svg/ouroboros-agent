// =============================================================================
// Checkpoint Manager — Session state snapshots for rewind/fork/resume (Phase 4)
// =============================================================================

import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FormattedMessage } from "../types/messages.js";
import type { BudgetStatus } from "../types/budget.js";

export interface CheckpointData {
  checkpointId: string;
  createdAt: number;
  label: string;
  messages: FormattedMessage[];
  sharedState: Record<string, unknown>;
  budgets: Record<string, BudgetStatus>;
  /** File paths modified since last checkpoint */
  modifiedFiles: string[];
}

export class CheckpointManager {
  private checkpointsDir: string;
  private sessionDir: string;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
    this.checkpointsDir = join(sessionDir, "checkpoints");
    mkdirSync(this.checkpointsDir, { recursive: true });
  }

  /** Create a checkpoint snapshot */
  create(params: {
    messages: FormattedMessage[];
    sharedState: Record<string, unknown>;
    budgets: Record<string, BudgetStatus>;
    label?: string;
    modifiedFiles?: string[];
  }): CheckpointData {
    const checkpointId = `ckpt-${Date.now().toString(36)}`;
    const ckptDir = join(this.checkpointsDir, checkpointId);
    mkdirSync(ckptDir, { recursive: true });

    const data: CheckpointData = {
      checkpointId,
      createdAt: Date.now(),
      label: params.label ?? `checkpoint-${checkpointId}`,
      messages: params.messages,
      sharedState: params.sharedState,
      budgets: params.budgets,
      modifiedFiles: params.modifiedFiles ?? [],
    };

    writeFileSync(join(ckptDir, "messages.json"), JSON.stringify(params.messages, null, 2), "utf-8");
    writeFileSync(join(ckptDir, "shared_state.json"), JSON.stringify(params.sharedState, null, 2), "utf-8");
    writeFileSync(join(ckptDir, "budget.json"), JSON.stringify(params.budgets, null, 2), "utf-8");
    writeFileSync(join(ckptDir, "meta.json"), JSON.stringify(data, null, 2), "utf-8");

    return data;
  }

  /** Restore from a checkpoint */
  restore(checkpointId: string): CheckpointData | null {
    const ckptDir = join(this.checkpointsDir, checkpointId);
    if (!existsSync(ckptDir)) return null;

    try {
      const messages = JSON.parse(readFileSync(join(ckptDir, "messages.json"), "utf-8"));
      const sharedState = JSON.parse(readFileSync(join(ckptDir, "shared_state.json"), "utf-8"));
      const budgets = JSON.parse(readFileSync(join(ckptDir, "budget.json"), "utf-8"));
      const meta = JSON.parse(readFileSync(join(ckptDir, "meta.json"), "utf-8"));

      return {
        checkpointId,
        createdAt: meta.createdAt,
        label: meta.label,
        messages,
        sharedState,
        budgets,
        modifiedFiles: meta.modifiedFiles ?? [],
      };
    } catch {
      return null;
    }
  }

  /** List all checkpoints for current session */
  list(): Array<{ id: string; createdAt: number; label: string }> {
    if (!existsSync(this.checkpointsDir)) return [];
    return readdirSync(this.checkpointsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        try {
          const meta = JSON.parse(readFileSync(join(this.checkpointsDir, d.name, "meta.json"), "utf-8"));
          return { id: d.name, createdAt: meta.createdAt, label: meta.label };
        } catch {
          return { id: d.name, createdAt: 0, label: "unknown" };
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}
