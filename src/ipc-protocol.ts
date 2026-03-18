/**
 * IPC protocol for session worker processes.
 *
 * Parent process (serve.ts) communicates with child workers (session-worker.ts)
 * via Node.js IPC channel (process.send / process.on('message')).
 *
 * All messages are JSON-serializable (no functions, classes, or circular refs).
 */

// ─── Parent → Worker messages ───

export interface IpcInitMessage {
  type: "init";
  agentId: string;
  userId: string;
  /** Serialized HarnessConfig (JSON string — HarnessConfig is a plain object) */
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
