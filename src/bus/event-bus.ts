// =============================================================================
// Ouroboros Event Bus — The nervous system (Phase 2 extended)
//
// Consumption modes:
//   - Sync subscribers: `bus.on(type, handler)` — for TUI state updates
//   - Async queue: `bus.createConsumer()` → async iterable — for Agent Loops
//   - Agent-targeted: `bus.createAgentConsumer(agentId)` — only receives
//     events targeting that agent or broadcast events
//
// Phase 2 additions:
//   - targetAgentId routing
//   - Topic subscriptions with glob matching
//   - Dead letter queue
//   - sendToAgent point-to-point
//   - broadcast to all agents
// =============================================================================

import type { EventType, OuroborosEvent } from "../types/events.js";

type SyncHandler = (event: OuroborosEvent) => void;
type Unsubscribe = () => void;

interface QueueItem {
  event: OuroborosEvent;
  resolve: () => void;
}

interface TopicSubscription {
  pattern: string;
  handler: (event: OuroborosEvent) => void;
}

interface DeadLetterEntry {
  event: OuroborosEvent;
  reason: string;
  timestamp: number;
}

export class EventBus {
  private syncSubscribers = new Map<EventType | "*", Set<SyncHandler>>();
  private queues: Array<{ push: (item: QueueItem) => void; agentId?: string }> = [];
  private topicSubscribers: TopicSubscription[] = [];
  private deadLetters: DeadLetterEntry[] = [];
  private sessionId: string;
  /** Per-agent event ordering queues (FIFO, separate from generic queues) */
  private agentQueues = new Map<string, QueueItem[]>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  // ---- Sync subscription (TUI) ---------------------------------------------

  on(type: EventType | "*", handler: SyncHandler): Unsubscribe {
    let subs = this.syncSubscribers.get(type);
    if (!subs) {
      subs = new Set();
      this.syncSubscribers.set(type, subs);
    }
    subs.add(handler);
    return () => { subs?.delete(handler); };
  }

  once(type: EventType, handler: SyncHandler): Unsubscribe {
    const unsub = this.on(type, (event) => {
      unsub();
      handler(event);
    });
    return unsub;
  }

  clear(): void {
    this.syncSubscribers.clear();
    this.queues = [];
    this.topicSubscribers = [];
    this.deadLetters = [];
  }

  // ---- Topic subscriptions -------------------------------------------------

  /** Subscribe to events matching a topic pattern. Supports * wildcard. */
  subscribeTopic(
    pattern: string,
    handler: (event: OuroborosEvent) => void,
  ): Unsubscribe {
    const sub: TopicSubscription = { pattern, handler };
    this.topicSubscribers.push(sub);
    return () => {
      const idx = this.topicSubscribers.indexOf(sub);
      if (idx >= 0) this.topicSubscribers.splice(idx, 1);
    };
  }

  /** Publish an event to a topic. All matching subscribers receive it. */
  publishTopic(topic: string, data: Record<string, unknown>): void {
    this.emit({
      eventId: crypto.randomUUID(),
      type: "TOPIC_PUBLISH",
      timestamp: performance.now(),
      sessionId: this.sessionId,
      causalChainId: crypto.randomUUID(),
      topic,
      payload: { topic, data },
    } as OuroborosEvent);
  }

  // ---- Dead Letter Queue ---------------------------------------------------

  /** Get all dead letter entries (for Coordinator periodic review). */
  getDeadLetters(): DeadLetterEntry[] {
    return [...this.deadLetters];
  }

  /** Drain the dead letter queue. */
  drainDeadLetters(): DeadLetterEntry[] {
    const entries = [...this.deadLetters];
    this.deadLetters = [];
    return entries;
  }

  // ---- Emit (extended) -----------------------------------------------------

  /**
   * Emit an event.
   * Routing logic:
   *   1. If targetAgentId is set → deliver only to that agent's consumer
   *   2. If targetAgentId is set but agent doesn't exist → DLQ
   *   3. If no target → broadcast to all consumers + sync subscribers
   */
  emit(event: OuroborosEvent): void {
    // Ensure sessionId
    if (!event.sessionId) {
      (event as { sessionId: string }).sessionId = this.sessionId;
    }

    this.validate(event);

    const targetId = event.targetAgentId;

    // --- Targeted delivery ---
    if (targetId) {
      let delivered = false;

      // Find agent-specific queue
      const pending = this.agentQueues.get(targetId);
      if (pending) {
        pending.push({ event, resolve: () => {} });
        delivered = true;
      }

      // Also check generic queues that match this agent
      for (const queue of this.queues) {
        if (queue.agentId === targetId || !queue.agentId) {
          queue.push({ event, resolve: () => {} });
          delivered = true;
        }
      }

      if (!delivered) {
        // Dead letter: target agent doesn't exist
        this.deadLetters.push({
          event,
          reason: `Agent "${targetId}" not found or has no active consumer`,
          timestamp: performance.now(),
        });
      }
    } else {
      // --- Broadcast ---
      // Sync subscribers
      this.notifySyncSubscribers(event);

      // All queues
      for (const queue of this.queues) {
        queue.push({ event, resolve: () => {} });
      }

      // Topic subscribers
      this.notifyTopicSubscribers(event);
    }
  }

  /**
   * Send an event to a specific agent. Point-to-point with ordering guarantee.
   */
  sendToAgent(targetAgentId: string, event: OuroborosEvent): void {
    event.targetAgentId = targetAgentId;
    this.emit(event);
  }

  /**
   * Broadcast an event to all agents except those listed.
   */
  broadcast(event: OuroborosEvent, excludeAgentIds?: string[]): void {
    delete event.targetAgentId;
    const exclude = new Set(excludeAgentIds ?? []);

    // Push to all queues except excluded agents
    for (const queue of this.queues) {
      if (queue.agentId && exclude.has(queue.agentId)) continue;
      queue.push({ event, resolve: () => {} });
    }

    // Notify sync subscribers
    this.notifySyncSubscribers(event);
    this.notifyTopicSubscribers(event);
  }

  // ---- Async consumers -----------------------------------------------------

  /** Create a generic consumer (receives all broadcast events). */
  createConsumer(): AsyncIterable<OuroborosEvent> {
    return this.buildConsumer(undefined);
  }

  /**
   * Create an agent-specific consumer.
   * Only receives events targeted to this agent or broadcast events.
   */
  createAgentConsumer(agentId: string): AsyncIterable<OuroborosEvent> {
    return this.buildConsumer(agentId);
  }

  // ---- Private -------------------------------------------------------------

  private buildConsumer(
    agentId: string | undefined,
  ): AsyncIterable<OuroborosEvent> {
    const pending: QueueItem[] = [];
    let resolveWait: ((value: IteratorResult<OuroborosEvent>) => void) | null = null;
    let done = false;

    const queue = {
      push: (item: QueueItem) => {
        pending.push(item);
        if (resolveWait) {
          const r = resolveWait;
          resolveWait = null;
          const next = pending.shift()!;
          r({ value: next.event, done: false });
        }
      },
      agentId,
    };

    this.queues.push(queue);

    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<OuroborosEvent> {
        return {
          async next(): Promise<IteratorResult<OuroborosEvent>> {
            if (done) return { value: undefined as never, done: true };

            if (pending.length > 0) {
              const item = pending.shift()!;
              return { value: item.event, done: false };
            }

            return new Promise((resolve) => {
              resolveWait = resolve;
            });
          },

          async return(): Promise<IteratorResult<OuroborosEvent>> {
            done = true;
            self.queues = self.queues.filter((q) => q !== queue);
            if (resolveWait) {
              resolveWait({ value: undefined as never, done: true });
              resolveWait = null;
            }
            return { value: undefined as never, done: true };
          },
        };
      },
    };
  }

  private notifySyncSubscribers(event: OuroborosEvent): void {
    const typeSubs = this.syncSubscribers.get(event.type);
    if (typeSubs) {
      for (const handler of typeSubs) {
        try { handler(event); } catch (err) { this.logError("sync handler error", err); }
      }
    }
    const wildSubs = this.syncSubscribers.get("*");
    if (wildSubs) {
      for (const handler of wildSubs) {
        try { handler(event); } catch (err) { this.logError("wildcard handler error", err); }
      }
    }
  }

  private notifyTopicSubscribers(event: OuroborosEvent): void {
    const topic = event.topic;
    if (!topic) return;

    for (const sub of this.topicSubscribers) {
      if (matchGlob(topic, sub.pattern)) {
        try { sub.handler(event); } catch (err) { this.logError("topic handler error", err); }
      }
    }
  }

  private validate(event: OuroborosEvent): void {
    if (!event.eventId) {
      throw new Error(`Event ${event.type} missing eventId`);
    }
    if (!event.timestamp) {
      throw new Error(`Event ${event.eventId} missing timestamp`);
    }
    if (!event.causalChainId) {
      (event as { causalChainId: string }).causalChainId = event.eventId;
    }
  }

  private logError(context: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[EventBus] ${context}: ${msg}\n`);
  }
}

// ---- Glob matching ---------------------------------------------------------

function matchGlob(str: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${regexStr}$`).test(str);
  } catch {
    return false;
  }
}
