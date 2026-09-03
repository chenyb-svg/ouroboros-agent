// =============================================================================
// Inbox — cross-instance message passing via the filesystem
// Messages land in ~/.ouroboros/instances/<target>/inbox/<uuid>.json.
// Three message types:
//   note  — fire-and-forget, surfaced to the LLM once (stamped readAt) via the
//           system prompt on the next query.
//   ask   — a question expecting a reply. Owned by the background Responder:
//           it claims (marks read) the ask, answers, and writes a `reply` back.
//   reply — the answer to an ask, matched by `thread`. Consumed by the asker's
//           blocking awaitReply().
// Device-agnostic `from` block keeps the format forward-compatible (device → hub).
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dataPath } from "../data-home.js";
import { randomUUID } from "node:crypto";

export interface InboxSender { sessionId: string; name: string; device: string }

export type InboxMessageType = "note" | "ask" | "reply";

export interface InboxMessage {
  id: string;
  from: InboxSender;
  to: string;
  /** undefined = "note" (backward compat with pre-protocol messages). */
  type?: InboxMessageType;
  /** ask/reply share a thread id so a response is matched to its request. */
  thread?: string;
  /** on an ask: the session id to send the reply back to. */
  replyTo?: string;
  text: string;
  sentAt: number;
  readAt: number | null;
}

const INSTANCES_DIR = () => dataPath("instances");
/** Target must be a plain session id (letters/digits/hyphen) — blocks path traversal. */
const TARGET_RE = /^[0-9A-Za-z-]{4,64}$/;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Inbox {
  private inboxDir: string;
  private rootDir: string;
  private sender: InboxSender;

  /** rootDir overrides ~/.ouroboros/instances — used by tests to isolate to a temp dir. */
  constructor(me: { sessionId: string; name: string; device: string }, rootDir?: string) {
    this.rootDir = rootDir ?? INSTANCES_DIR();
    this.inboxDir = join(this.rootDir, me.sessionId, "inbox");
    this.sender = { sessionId: me.sessionId, name: me.name, device: me.device };
    try { mkdirSync(this.inboxDir, { recursive: true }); } catch { /* best-effort */ }
  }

  /** Runtime display-name rename — new outgoing messages carry the new sender name. */
  setName(name: string): void {
    if (name) this.sender.name = name;
  }

  /** Core write used by all variants. Never throws. */
  private write(
    target: string,
    text: string,
    opts: { type?: InboxMessageType; thread?: string; replyTo?: string } = {},
  ): { ok: boolean; error?: string; id?: string } {
    const t = (target || "").trim();
    if (!TARGET_RE.test(t)) return { ok: false, error: `Invalid target session id: "${target}"` };
    const msg: InboxMessage = {
      id: randomUUID(),
      from: { ...this.sender },
      to: t,
      text: String(text).slice(0, 4000),
      sentAt: Date.now(),
      readAt: null,
    };
    if (opts.type) msg.type = opts.type;
    if (opts.thread) msg.thread = opts.thread;
    if (opts.replyTo) msg.replyTo = opts.replyTo;
    const targetDir = join(this.rootDir, t, "inbox");
    try {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, `${msg.id}.json`), JSON.stringify(msg, null, 2), "utf-8");
      return { ok: true, id: msg.id };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /** Send a notification message to another instance. Never throws. */
  send(target: string, text: string): { ok: boolean; error?: string; id?: string } {
    return this.write(target, text, {});
  }

  /** Ask another instance a question; returns the thread id to await a reply on. */
  sendAsk(target: string, text: string): { ok: boolean; error?: string; thread?: string } {
    const thread = randomUUID();
    const r = this.write(target, text, { type: "ask", thread, replyTo: this.sender.sessionId });
    return r.ok ? { ok: true, thread } : { ok: false, error: r.error };
  }

  /** Reply to an ask, reusing the ask's thread id so the asker can match it. */
  sendReply(to: string, thread: string, text: string): { ok: boolean; error?: string } {
    return this.write(to, text, { type: "reply", thread });
  }

  /** Read unread messages, oldest-first. If markRead, stamp readAt and rewrite. */
  readOwnInbox(markRead: boolean): InboxMessage[] {
    const out: InboxMessage[] = [];
    let files: string[] = [];
    try { files = readdirSync(this.inboxDir).filter((f) => f.endsWith(".json")); } catch { return out; }
    for (const f of files) {
      try {
        const msg = JSON.parse(readFileSync(join(this.inboxDir, f), "utf-8")) as InboxMessage;
        if (!msg || msg.readAt) continue;
        if (markRead) {
          msg.readAt = Date.now();
          writeFileSync(join(this.inboxDir, f), JSON.stringify(msg, null, 2), "utf-8");
        }
        out.push(msg);
      } catch { /* corrupt message — skip */ }
    }
    // Chronological; ties (same-ms sends) break on id so the order is stable
    // regardless of readdir order.
    out.sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id));
    return out;
  }

  /** Oldest unread ask addressed to me (does NOT stamp read — call markMessageRead to claim). */
  nextUnreadAsk(): InboxMessage | null {
    return this.readOwnInbox(false).find((m) => m.type === "ask") ?? null;
  }

  /** Stamp readAt on one specific message (used to claim an ask at-most-once). */
  markMessageRead(id: string): void {
    try {
      const p = join(this.inboxDir, `${id}.json`);
      const msg = JSON.parse(readFileSync(p, "utf-8")) as InboxMessage;
      msg.readAt = Date.now();
      writeFileSync(p, JSON.stringify(msg, null, 2), "utf-8");
    } catch { /* best-effort */ }
  }

  /**
   * Block until a reply for `thread` arrives in my inbox (or timeout/abort).
   * Consumes the reply (stamps read) so it is not surfaced again. Never throws.
   */
  async awaitReply(
    thread: string,
    timeoutMs: number,
    isAborted?: () => boolean,
    pollMs = 1000,
  ): Promise<{ text: string } | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isAborted?.()) return null;
      const reply = this.readOwnInbox(false).find((m) => m.type === "reply" && m.thread === thread);
      if (reply) {
        this.markMessageRead(reply.id);
        return { text: reply.text };
      }
      await sleep(pollMs);
    }
    return null;
  }

  markAllRead(): number {
    const msgs = this.readOwnInbox(false);
    for (const m of msgs) {
      try {
        m.readAt = Date.now();
        writeFileSync(join(this.inboxDir, `${m.id}.json`), JSON.stringify(m, null, 2), "utf-8");
      } catch { /* best-effort */ }
    }
    return msgs.length;
  }

  countUnread(): number {
    return this.readOwnInbox(false).length;
  }
}
