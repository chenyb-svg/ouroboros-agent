// =============================================================================
// Debug Server — Minimal HTTP dashboard for agent observability (Phase 5)
// =============================================================================

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dataPath } from "../data-home.js";
import { listenFallback } from "../coordination/listen-fallback.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { EventBus } from "../bus/event-bus.js";
import type { TaskRegistry } from "../orchestration/task-registry.js";

export interface DebugServerContext {
  agentRegistry?: AgentRegistry;
  bus?: EventBus;
  tasks?: TaskRegistry;
  telemetry?: any;
  audit?: any;
  hookRegistry?: { list: () => Array<{ anchor: string; source: string; priority: number }> };
}

export class DebugServer {
  private server: ReturnType<typeof createServer> | null = null;
  private ctx: DebugServerContext;
  private port: number;
  private authToken: string;

  constructor(ctx: DebugServerContext, port: number = 9876) {
    this.ctx = ctx;
    this.port = port;

    // Auth token from file or generate
    const tokenPath = dataPath("debug.token");
    if (existsSync(tokenPath)) {
      this.authToken = readFileSync(tokenPath, "utf-8").trim();
    } else {
      this.authToken = `debug-${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  start(onPort?: (port: number) => void): void {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    // Port fallback so the second instance's /debug doesn't crash on EADDRINUSE.
    listenFallback(this.server, this.port, { name: "Debug", host: "127.0.0.1", onPort: (p) => {
      process.stderr.write(`[Debug] Dashboard at http://localhost:${p}\n`);
      process.stderr.write(`[Debug] Token: ${this.authToken}\n`);
      onPort?.(p);
    } });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = req.url ?? "/";

    // Auth check (skip for root HTML page)
    if (url !== "/" && url !== "/favicon.ico") {
      const auth = req.headers["authorization"];
      if (!auth || auth !== `Bearer ${this.authToken}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized. Use Authorization: Bearer <token>" }));
        return;
      }
    }

    switch (url) {
      case "/": return this.serveDashboard(res);
      case "/api/agents": return this.serveJson(res, this.getAgents());
      case "/api/tasks": return this.serveJson(res, this.getTasks());
      case "/api/metrics": return this.serveJson(res, this.getMetrics());
      case "/api/audit": return this.serveJson(res, this.ctx.audit?.getRecent?.(50) ?? []);
      case "/api/hooks": return this.serveJson(res, this.ctx.hookRegistry?.list() ?? []);
      default: res.writeHead(404); res.end("Not found");
    }
  }

  /** Safe metrics accessor — telemetry is optional; return a zero-shaped object when absent */
  private getMetrics(): any {
    const m = this.ctx.telemetry?.getMetrics?.();
    if (m && typeof m === "object") return m;
    return {
      tokens: { totalCompletion: 0 },
      tools: { successRate: 0 },
      llm: { p50LatencyMs: 0 },
      memory: { heapUsedMB: 0 },
      compression: { triggers: 0 },
    };
  }

  private serveJson(res: ServerResponse, data: unknown): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
  }

  private serveDashboard(res: ServerResponse): void {
    const metrics = this.getMetrics();
    const agents = this.getAgents();
    const tasks = this.getTasks();

    const html = `<!DOCTYPE html>
<html><head><title>Ouroboros Debug</title>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:monospace;background:#1a1a2e;color:#e0e0e0;padding:20px;margin:0}
  h1{color:#00d4ff}h2{color:#ff6b6b;margin-top:24px}
  .card{background:#16213e;border:1px solid #0f3460;border-radius:8px;padding:16px;margin:8px 0}
  .metric{display:inline-block;background:#0f3460;border-radius:6px;padding:10px 16px;margin:4px;text-align:center}
  .metric .value{font-size:24px;font-weight:bold;color:#00d4ff}
  .metric .label{font-size:12px;color:#aaa;margin-top:4px}
  .agent-ok{border-left:3px solid #00ff88}.agent-busy{border-left:3px solid #ff6b6b}
  table{width:100%;border-collapse:collapse;margin:8px 0}
  th,td{padding:6px 12px;text-align:left;border-bottom:1px solid #0f3460}
  th{color:#00d4ff}
  .refresh{color:#aaa;font-size:12px;float:right}
</style></head><body>
<h1>Ouroboros Debug Dashboard <span class="refresh">v0.5.0</span></h1>

<h2>Overview</h2>
<div>
  <div class="metric"><div class="value">${agents.length}</div><div class="label">Agents</div></div>
  <div class="metric"><div class="value">${metrics.tokens.totalCompletion.toLocaleString()}</div><div class="label">Tokens</div></div>
  <div class="metric"><div class="value">${(metrics.tools.successRate * 100).toFixed(1)}%</div><div class="label">Tool Success</div></div>
  <div class="metric"><div class="value">${metrics.llm.p50LatencyMs}ms</div><div class="label">P50 Latency</div></div>
  <div class="metric"><div class="value">${metrics.memory.heapUsedMB}MB</div><div class="label">Heap</div></div>
  <div class="metric"><div class="value">${metrics.compression.triggers}</div><div class="label">Compactions</div></div>
</div>

<h2>Agents (${agents.length})</h2>
${agents.map((a: any) =>
  `<div class="card agent-${a.state === 'active' ? 'busy' : 'ok'}">
    <strong>${a.id}</strong> [${a.state}]
    Type: ${a.type} | Turns: ${a.turns ?? 0} | Tokens: ${a.tokens ?? 0}
  </div>`
).join("") || "<div class='card'>No agents</div>"}

<h2>Tasks (${tasks.length})</h2>
<table><tr><th>ID</th><th>Status</th><th>Agent</th><th>Description</th></tr>
${tasks.map((t: any) =>
  `<tr><td>${t.taskId}</td><td>${t.status}</td><td>${t.assignedAgentId ?? '-'}</td><td>${t.description?.slice(0, 60) ?? ''}</td></tr>`
).join("") || "<tr><td colspan=4>No tasks</td></tr>"}</table>

<p style="color:#aaa;margin-top:32px;font-size:12px">
  API: /api/agents | /api/tasks | /api/metrics | /api/audit | /api/hooks
</p>
</body></html>`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  private getAgents(): Array<Record<string, unknown>> {
    if (!this.ctx.agentRegistry) return [];
    const instances = this.ctx.agentRegistry.listInstances();
    return instances.map((i) => ({
      id: `${i.contract.identity.source}:${i.contract.identity.name}`,
      type: i.contract.type,
      state: i.state,
      turns: i.budgetStatus?.turnsUsed ?? 0,
      tokens: i.budgetStatus?.tokensUsed ?? 0,
    }));
  }

  private getTasks(): Array<Record<string, unknown>> {
    if (!this.ctx.tasks) return [];
    return this.ctx.tasks.getAllTasks().map((t) => ({
      taskId: t.taskId,
      status: t.status,
      assignedAgentId: t.assignedAgentId,
      description: t.description,
    }));
  }
}
