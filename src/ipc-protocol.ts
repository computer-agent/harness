/**
 * IPC protocol for session worker processes.
 *
 * Parent process (serve.ts) communicates with child workers (session-worker.ts)
 * via Node.js IPC channel (process.send / process.on('message')).
 *
 * All messages are JSON-serializable (no functions, classes, or circular refs).
 */

// ─── Parent → Worker messages ───

/**
 * W7-T11: Worker config subset — only what the worker needs.
 * Full HarnessConfig contains serve.rateLimits, serve.privacy, etc.
 * which are irrelevant inside a worker and increase information exposure.
 */
export interface WorkerConfig {
  model: string;
  effort: "low" | "medium" | "high" | "max";
  tools: {
    memory: { enabled: boolean };
    workspace: { enabled: boolean };
    web: { enabled: boolean; extraction_model?: string };
    shell: { enabled: boolean };
    tasks: { enabled: boolean };
    introspection: { enabled: boolean };
    models: { enabled: boolean };
    scratchpad: { enabled: boolean };
    a2a: { enabled: boolean; agents: Record<string, { url: string; description: string }> };
  };
  hooks: {
    logToolUse: boolean;
    verifyBeforeComplete: boolean;
    loopDetection: boolean;
    loopDetectionThreshold: number;
    compactSuccessOutput: boolean;
    compactOutputThreshold: number;
  };
  serve?: {
    logging?: { level?: "debug" | "info" | "warn" | "error" };
  };
}

export interface IpcInitMessage {
  type: "init";
  agentId: string;
  userId: string;
  /** Serialized WorkerConfig (JSON string — only the subset the worker needs) */
  configJson: string;
  /** Subset of AccessUser needed by the worker */
  accessUser: { name: string; toolsDeny: string[] };
}

export interface IpcUserMessage {
  type: "message";
  content: string;
  /** SDK session ID to resume (only if previously confirmed by SDK init event) */
  resumeSessionId?: string;
}

export interface IpcInterruptMessage {
  type: "interrupt";
}

export interface IpcToolApprovalResponse {
  type: "tool_approval_response";
  toolId: string;
  approved: boolean;
}

export interface IpcShutdownMessage {
  type: "shutdown";
}

export type ParentToWorkerMessage =
  | IpcInitMessage
  | IpcUserMessage
  | IpcInterruptMessage
  | IpcToolApprovalResponse
  | IpcShutdownMessage;

// ─── Worker → Parent messages ───

export interface IpcReadyMessage {
  type: "ready";
}

/** Forward a WebSocket frame to the client (already JSON-serializable) */
export interface IpcFrameMessage {
  type: "frame";
  frame: Record<string, unknown>;
}

/** SDK assigned a session ID during init */
export interface IpcSessionIdMessage {
  type: "session_id";
  sessionId: string;
  firstMessage: string;
}

/** Worker needs user approval for a tool use */
export interface IpcToolApprovalRequest {
  type: "tool_approval_request";
  toolId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

/** Query completed */
export interface IpcResultMessage {
  type: "result";
  sessionId: string | null;
  interrupted: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  responseContent: string;
  toolCalls: Array<{ name: string; status: string }>;
}

/** Error occurred in worker */
export interface IpcErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type WorkerToParentMessage =
  | IpcReadyMessage
  | IpcFrameMessage
  | IpcSessionIdMessage
  | IpcToolApprovalRequest
  | IpcResultMessage
  | IpcErrorMessage;

// ─── Allowed frame types (W7-T08) ───
//
// Module-level constant co-located with the frame type definitions.
// Auditable list of frame types that a worker process may relay to a WebSocket client.
// Any frame with a `type` not in this set is rejected by serve.ts.
export const ALLOWED_FRAME_TYPES: ReadonlySet<string> = new Set([
  "status",
  "token",
  "thinking_token",
  "tool_use_start",
  "tool_use_input",
  "tool_result",
  "subagent_started",
  "subagent_progress",
  "subagent_done",
]);

// ─── Type guards ───

export function isParentToWorkerMessage(msg: unknown): msg is ParentToWorkerMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    m.type === "init" ||
    m.type === "message" ||
    m.type === "interrupt" ||
    m.type === "tool_approval_response" ||
    m.type === "shutdown"
  );
}

export function isWorkerToParentMessage(msg: unknown): msg is WorkerToParentMessage {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    m.type === "ready" ||
    m.type === "frame" ||
    m.type === "session_id" ||
    m.type === "tool_approval_request" ||
    m.type === "result" ||
    m.type === "error"
  );
}
