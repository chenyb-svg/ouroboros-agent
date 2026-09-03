// =============================================================================
// MCP Protocol Types — Model Context Protocol integration (Phase 5)
// =============================================================================

export type McpTransportType = "stdio" | "sse";

export interface McpServerConfig {
  name: string;
  transport: McpTransportType;
  /** For stdio: command to spawn */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** For SSE: URL endpoint */
  url?: string;
  /** Auto-connect on startup vs lazy */
  autoConnect?: boolean;
  /** Timeout for tool calls in ms */
  timeoutMs?: number;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export interface CallToolRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface CallToolResult {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

export interface McpServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
  capabilities: {
    tools?: boolean;
    resources?: boolean;
    prompts?: boolean;
  };
}

export type McpConnectionState = "disconnected" | "connecting" | "connected" | "unhealthy";
