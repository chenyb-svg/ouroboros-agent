// =============================================================================
// Ouroboros Event System — The nervous system contract (Phase 2 extended)
// =============================================================================

/** All event type literals used on the bus */
export type EventType =
  | "USER_INPUT"
  | "LLM_CHUNK"
  | "LLM_RESPONSE_COMPLETE"
  | "TOOL_CALL"
  | "TOOL_RESULT"
  | "PERMISSION_REQUEST"
  | "PERMISSION_RESOLVED"
  | "SYSTEM_ERROR"
  | "AGENT_STUCK"
  | "LLM_INVALID_REQUEST"
  | "CONFIG_RELOAD"
  | "TERMINAL_RESIZE"
  | "INTERRUPT_REQUEST"
  | "RENDER_MARKDOWN"
  | "RENDER_OVERLAY"
  | "RENDER_STATUS"
  | "STATE_CHANGE"
  | "SESSION_START"
  | "SESSION_END"
  // ---- Phase 2: Multi-Agent Events ----
  | "AGENT_SPAWNED"
  | "AGENT_TERMINATED"
  | "DELEGATE"
  | "RESULT_REPORT"
  | "BUDGET_EXCEEDED"
  | "SHARED_STATE_CHANGED"
  | "SKILL_LOAD_FAILED"
  | "SKILL_CONFLICT"
  | "ENV_COMPAT_WARNING"
  | "TOPIC_PUBLISH"
  // Phase 5
  | "MCP_SERVER_CONNECTED"
  | "MCP_SERVER_DISCONNECTED"
  | "VIRTUALIZATION_BLOCKED";

/** Every event on the bus carries this envelope */
export interface BaseEvent {
  eventId: string;       // UUIDv4
  type: EventType;
  timestamp: number;     // performance.now() high-precision
  sessionId: string;
  causalChainId: string; // traces back to the originating USER_INPUT eventId
  /** Phase 2: target a specific agent. If undefined, event is broadcast. */
  targetAgentId?: string;
  /** Phase 2: the agent that emitted this event */
  sourceAgentId?: string;
  /** Phase 2: topic for topic-based routing */
  topic?: string;
}

// ---- Phase 1 events (unchanged) ---------------------------------------------

export interface UserInputEvent extends BaseEvent {
  type: "USER_INPUT";
  payload: { text: string; raw: string };
}

export interface LlmChunkEvent extends BaseEvent {
  type: "LLM_CHUNK";
  payload: { delta: string; index: number };
}

export interface LlmResponseCompleteEvent extends BaseEvent {
  type: "LLM_RESPONSE_COMPLETE";
  payload: {
    fullText: string;
    finishReason: "stop" | "tool_calls" | "length" | "error";
    usage?: { promptTokens: number; completionTokens: number };
  };
}

export interface ToolCallEvent extends BaseEvent {
  type: "TOOL_CALL";
  payload: {
    toolCallId: string;
    toolName: string;        // Phase 2: this is now an FQN
    args: Record<string, unknown>;
    requiresPermission: boolean;
    /** Phase 2: which agent called this tool */
    agentId?: string;
  };
}

export interface ToolResultEvent extends BaseEvent {
  type: "TOOL_RESULT";
  payload: {
    toolCallId: string;
    success: boolean;
    output: string;
    error?: string;
  };
}

export interface PermissionRequestEvent extends BaseEvent {
  type: "PERMISSION_REQUEST";
  payload: {
    permissionId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    reason: string;
    /** Phase 2: delegation chain for display */
    delegationChain?: string[];
  };
}

export interface PermissionResolvedEvent extends BaseEvent {
  type: "PERMISSION_RESOLVED";
  payload: {
    permissionId: string;
    toolCallId: string;
    granted: boolean;
  };
}

export interface SystemErrorEvent extends BaseEvent {
  type: "SYSTEM_ERROR";
  payload: {
    code: string;
    message: string;
    recoverable: boolean;
    stack?: string;
  };
}

export interface AgentStuckEvent extends BaseEvent {
  type: "AGENT_STUCK";
  payload: {
    agentId: string;
    reason: "repetitive" | "empty_turns";
    turnCount: number;
    detail?: string;
  };
}

export interface LlmInvalidRequestEvent extends BaseEvent {
  type: "LLM_INVALID_REQUEST";
  payload: {
    kind: string;
    statusCode?: number;
    message: string;
    retryable: boolean;
  };
}

export interface ConfigReloadEvent extends BaseEvent {
  type: "CONFIG_RELOAD";
  payload: {
    source: "project" | "user" | "system";
    path: string;
  };
}

export interface TerminalResizeEvent extends BaseEvent {
  type: "TERMINAL_RESIZE";
  payload: { width: number; height: number };
}

export interface InterruptRequestEvent extends BaseEvent {
  type: "INTERRUPT_REQUEST";
  payload: { count: number };
}

export interface RenderMarkdownEvent extends BaseEvent {
  type: "RENDER_MARKDOWN";
  payload: {
    markdown: string;
    target: "content" | "status";
    /** Phase 2: agent badge to display */
    agentBadge?: string;
  };
}

export interface RenderOverlayEvent extends BaseEvent {
  type: "RENDER_OVERLAY";
  payload: {
    visible: boolean;
    kind: "confirm" | "error" | "info" | "task-list";
    title: string;
    message: string;
    buttons: string[];
    permissionId?: string;
    /** Phase 2: delegation chain for display */
    delegationChain?: string[];
  };
}

export interface RenderStatusEvent extends BaseEvent {
  type: "RENDER_STATUS";
  payload: {
    state: string;
    sessionId: string;
    model?: string;
    contextUsage?: number;
    /** Phase 2 */
    activeAgentCount?: number;
    warningCount?: number;
  };
}

export interface StateChangeEvent extends BaseEvent {
  type: "STATE_CHANGE";
  payload: {
    previous: string;
    current: string;
    reason: string;
    /** Phase 2: which agent changed state */
    agentId?: string;
  };
}

export interface SessionStartEvent extends BaseEvent {
  type: "SESSION_START";
  payload: {
    sessionId: string;
    workDir: string;
    configSnapshot: Record<string, unknown>;
  };
}

export interface SessionEndEvent extends BaseEvent {
  type: "SESSION_END";
  payload: {
    reason: "user_exit" | "error" | "interrupt" | "sigterm";
    transcriptPath: string;
  };
}

// ---- Phase 2: Multi-Agent Events --------------------------------------------

export interface AgentSpawnedEvent extends BaseEvent {
  type: "AGENT_SPAWNED";
  payload: {
    instanceId: string;
    agentId: string;         // the contract ID string
    agentType: string;
    parentInstanceId?: string;
    taskId?: string;
  };
}

export interface AgentTerminatedEvent extends BaseEvent {
  type: "AGENT_TERMINATED";
  payload: {
    instanceId: string;
    agentId: string;
    reason: string;
    turnsTaken: number;
    tokensUsed: number;
  };
}

export interface DelegateEvent extends BaseEvent {
  type: "DELEGATE";
  payload: {
    taskId: string;
    targetAgentId: string;
    taskDescription: string;
    expectedDeliverable: string;
    authorizedTools: string[];
    budget: Record<string, unknown>;
  };
}

export interface ResultReportEvent extends BaseEvent {
  type: "RESULT_REPORT";
  payload: {
    taskId: string;
    success: boolean;
    summary: string;
    rawOutput?: string;
    filesModified?: string[];
    tokensUsed: number;
    turnsTaken: number;
    errors?: string[];
  };
}

export interface BudgetExceededEvent extends BaseEvent {
  type: "BUDGET_EXCEEDED";
  payload: {
    agentInstanceId: string;
    agentId: string;
    reason: string;
    budgetStatus: Record<string, unknown>;
  };
}

export interface SharedStateChangedEvent extends BaseEvent {
  type: "SHARED_STATE_CHANGED";
  payload: {
    key: string;
    oldValue: unknown;
    newValue: unknown;
    writtenBy: string;
  };
}

export interface SkillLoadFailedEvent extends BaseEvent {
  type: "SKILL_LOAD_FAILED";
  payload: {
    path: string;
    adapter: string;
    error: string;
  };
}

export interface SkillConflictEvent extends BaseEvent {
  type: "SKILL_CONFLICT";
  payload: {
    agentName: string;
    existingSource: string;
    newSource: string;
    resolution: string;
  };
}

export interface EnvCompatWarningEvent extends BaseEvent {
  type: "ENV_COMPAT_WARNING";
  payload: {
    adapter: string;
    message: string;
    suggestion: string;
  };
}

export interface TopicPublishEvent extends BaseEvent {
  type: "TOPIC_PUBLISH";
  payload: {
    topic: string;
    data: Record<string, unknown>;
  };
}

// ---- Phase 5 events ---------------------------------------------------------

export interface McpServerConnectedEvent extends BaseEvent {
  type: "MCP_SERVER_CONNECTED";
  payload: { serverName: string; toolCount: number };
}

export interface McpServerDisconnectedEvent extends BaseEvent {
  type: "MCP_SERVER_DISCONNECTED";
  payload: { serverName: string; reason: string };
}

export interface VirtualizationBlockedEvent extends BaseEvent {
  type: "VIRTUALIZATION_BLOCKED";
  payload: { resource: string; reason: string; agentId: string };
}

// ---- Discriminated union ----------------------------------------------------

export type OuroborosEvent =
  | UserInputEvent
  | LlmChunkEvent
  | LlmResponseCompleteEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | PermissionResolvedEvent
  | SystemErrorEvent
  | AgentStuckEvent
  | LlmInvalidRequestEvent
  | ConfigReloadEvent
  | TerminalResizeEvent
  | InterruptRequestEvent
  | RenderMarkdownEvent
  | RenderOverlayEvent
  | RenderStatusEvent
  | StateChangeEvent
  | SessionStartEvent
  | SessionEndEvent
  // Phase 2
  | AgentSpawnedEvent
  | AgentTerminatedEvent
  | DelegateEvent
  | ResultReportEvent
  | BudgetExceededEvent
  | SharedStateChangedEvent
  | SkillLoadFailedEvent
  | SkillConflictEvent
  | EnvCompatWarningEvent
  | TopicPublishEvent
  // Phase 5
  | McpServerConnectedEvent
  | McpServerDisconnectedEvent
  | VirtualizationBlockedEvent;

export type EventHandler<T extends OuroborosEvent = OuroborosEvent> = (event: T) => void | Promise<void>;
