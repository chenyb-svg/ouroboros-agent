// =============================================================================
// Rewind — Restore session to a previous checkpoint (Phase 4)
// =============================================================================

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { CheckpointManager } from "./checkpoint.js";
import type { EventBus } from "../bus/event-bus.js";
import type { TranscriptWriter } from "./transcript.js";

export interface RewindResult {
  success: boolean;
  checkpointId: string;
  messagesRestored: number;
  error?: string;
}

/**
 * Rewind the current session to a checkpoint.
 * Restores messages + shared state. Appends rewind audit event to transcript.
 */
export function rewindTo(
  checkpointId: string,
  ckptManager: CheckpointManager,
  bus: EventBus,
  transcript: TranscriptWriter,
  sessionId: string,
  stateRef: {
    contentLines: string[];
    sharedState: Record<string, unknown>;
    messages: any[];
  },
): RewindResult {
  const ckpt = ckptManager.restore(checkpointId);
  if (!ckpt) {
    return { success: false, checkpointId, messagesRestored: 0, error: "Checkpoint not found" };
  }

  // Restore messages
  stateRef.messages = ckpt.messages;

  // Restore content lines (rebuild from messages for simplicity)
  stateRef.contentLines.length = 0;
  stateRef.contentLines.push(`[Rewound to checkpoint: ${ckpt.label}]`);
  for (const msg of ckpt.messages) {
    stateRef.contentLines.push(`[${msg.role}] ${msg.content.slice(0, 120)}`);
  }

  // Restore shared state
  for (const key of Object.keys(stateRef.sharedState)) {
    delete stateRef.sharedState[key];
  }
  Object.assign(stateRef.sharedState, ckpt.sharedState);

  // Append rewind event to transcript
  const rewindEvent = {
    eventId: randomUUID(),
    type: "STATE_CHANGE",
    timestamp: performance.now(),
    sessionId,
    causalChainId: randomUUID(),
    payload: {
      previous: "active",
      current: "rewound",
      reason: `Rewind to checkpoint ${checkpointId}: ${ckpt.label}`,
      agentId: "system",
    },
  };

  transcript.append(rewindEvent as any);

  // Emit rewind on bus
  bus.emit({
    eventId: randomUUID(),
    type: "STATE_CHANGE",
    timestamp: performance.now(),
    sessionId,
    causalChainId: randomUUID(),
    payload: {
      previous: "active",
      current: "rewound",
      reason: `Rewound to ${checkpointId}`,
    },
  } as any);

  return {
    success: true,
    checkpointId,
    messagesRestored: ckpt.messages.length,
  };
}
