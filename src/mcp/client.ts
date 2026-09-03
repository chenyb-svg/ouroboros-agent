// =============================================================================
// MCP Client — Model Context Protocol stdio transport (Phase 5)
// =============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  McpServerConfig, McpToolDefinition, CallToolRequest, CallToolResult,
  McpServerInfo, McpConnectionState,
} from "../types/mcp.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpClient {
  readonly serverName: string;
  private config: McpServerConfig;
  private process: ChildProcess | null = null;
  private state: McpConnectionState = "disconnected";
  private pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";
  private serverInfo: McpServerInfo | null = null;
  private toolsCache: McpToolDefinition[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.serverName = config.name;
  }

  get connectionState(): McpConnectionState { return this.state; }
  get tools(): McpToolDefinition[] { return this.toolsCache; }

  /** Connect via stdio transport */
  async connect(): Promise<McpServerInfo> {
    if (this.state === "connected") return this.serverInfo!;

    this.state = "connecting";
    const cmd = this.config.command ?? "npx";
    const args = this.config.args ?? [];

    this.process = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.config.env },
    });

    this.process.stdout?.on("data", (chunk: Buffer) => this.handleData(chunk.toString()));
    this.process.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[MCP:${this.serverName}] ${chunk.toString()}`);
    });
    this.process.on("exit", (code) => {
      this.state = "disconnected";
      this.process = null;
    });

    // Initialize handshake
    const info = await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "ouroboros-agent", version: "0.5.0" },
    }) as McpServerInfo;

    this.serverInfo = info;
    this.state = "connected";

    // Send initialized notification
    this.sendNotification("notifications/initialized", {});

    // Discover tools
    const toolsResult = await this.sendRequest("tools/list", {}) as { tools: McpToolDefinition[] };
    this.toolsCache = toolsResult.tools ?? [];

    // Start heartbeat
    this.lastPong = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastPong > 60000) {
        this.state = "unhealthy";
      }
      this.sendNotification("ping", {}).catch(() => {});
    }, 30000);

    return info;
  }

  /** Call a tool on the MCP server */
  async callTool(request: CallToolRequest): Promise<CallToolResult> {
    if (this.state !== "connected") await this.connect();

    const timeout = this.config.timeoutMs ?? 30000;
    const result = await this.sendRequest("tools/call", {
      name: request.name,
      arguments: request.arguments,
    }, timeout) as CallToolResult;

    return result;
  }

  /** Disconnect gracefully */
  async disconnect(): Promise<void> {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }

    if (this.process && this.state === "connected") {
      try {
        await this.sendRequest("shutdown", {}, 5000);
      } catch { /* force kill below */ }
    }

    if (this.process) {
      this.process.kill("SIGTERM");
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 5000);
    }

    this.state = "disconnected";
    this.process = null;
  }

  // ---- Private ----

  private sendRequest(method: string, params: Record<string, unknown>, timeoutMs: number = 30000): Promise<unknown> {
    const id = randomUUID();
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.sendRaw(JSON.stringify(request));
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): Promise<void> {
    const notif = { jsonrpc: "2.0" as const, method, params };
    return Promise.resolve(this.sendRaw(JSON.stringify(notif)));
  }

  private sendRaw(data: string): void {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(data + "\n");
    }
  }

  private handleData(data: string): void {
    this.buffer += data;

    // Process complete lines
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? ""; // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pendingRequests.has(msg.id)) {
          const pending = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);

          if (msg.error) {
            pending.reject(new Error(`MCP error: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        }
        // Track pong for heartbeat
        if (msg.method === "pong" || msg.id === undefined) {
          this.lastPong = Date.now();
        }
      } catch {
        // Skip non-JSON output
      }
    }
  }
}
