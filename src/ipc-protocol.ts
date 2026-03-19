/**
 * IPC protocol for session worker processes.
 *
 * Parent process (serve.ts) communicates with child workers (session-worker.ts)
 * via Node.js IPC channel (process.send / process.on('message')).
 *
 * All messages are JSON-serializable (no functions, classes, or circular refs).
 */

import type { WsServerMessage, WsStatus, WsSubagentDone, WsToken, WsToolUseStart } from "./types/ws.js";

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

// ─── Frame type guard and sanitization (W8.1-T02, W8.1-T11) ───

/**
 * W8.1-T11: Runtime type guard for frames that should be buffered for reconnection replay.
 * Co-located with ALLOWED_FRAME_TYPES. Validates the frame shape at runtime instead of
 * relying on `as unknown as` casts.
 * Only `token` and `tool_use_start` frames carry an `id` field needed by MessageBuffer.
 */
export function isBufferableFrame(frame: { type?: string }): frame is WsToken | WsToolUseStart {
  if (frame.type === "token") {
    return typeof (frame as WsToken).id === "number" && typeof (frame as WsToken).text === "string";
  }
  if (frame.type === "tool_use_start") {
    const f = frame as WsToolUseStart;
    return typeof f.id === "number" && typeof f.toolName === "string" && typeof f.toolId === "string";
  }
  return false;
}

// ─── Helpers for runtime type validation ───

const VALID_STATUS_VALUES = new Set(["thinking", "responding", "tool_use", "idle", "interrupted"]);
const VALID_SUBAGENT_STATUS_VALUES = new Set(["completed", "failed", "stopped"]);

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isNumber(v: unknown): v is number {
  return typeof v === "number";
}

/**
 * W8.1-T02: Construct new objects with only known fields before relaying IPC frames to WebSocket.
 * A compromised worker could inject extra properties — this strips them.
 * Returns null if the frame type is not in ALLOWED_FRAME_TYPES or if required fields
 * are missing/wrong type.
 *
 * Review fix #2: Runtime typeof checks on every field — the worker is untrusted.
 */
export function sanitizeFrame(raw: Record<string, unknown>): WsServerMessage | null {
  const frameType = raw.type as string | undefined;
  if (!frameType || !ALLOWED_FRAME_TYPES.has(frameType)) return null;

  switch (frameType) {
    case "status": {
      if (!isString(raw.status) || !VALID_STATUS_VALUES.has(raw.status)) return null;
      return { type: "status", status: raw.status as WsStatus["status"] };
    }
    case "token": {
      if (!isNumber(raw.id) || !isString(raw.text)) return null;
      return { type: "token", id: raw.id, text: raw.text };
    }
    case "thinking_token": {
      if (!isString(raw.text)) return null;
      return { type: "thinking_token", text: raw.text };
    }
    case "tool_use_start": {
      if (!isNumber(raw.id) || !isString(raw.toolName) || !isString(raw.toolId)) return null;
      return { type: "tool_use_start", id: raw.id, toolName: raw.toolName, toolId: raw.toolId };
    }
    case "tool_use_input": {
      if (!isString(raw.toolId) || !isString(raw.partialJson)) return null;
      return { type: "tool_use_input", toolId: raw.toolId, partialJson: raw.partialJson };
    }
    case "tool_result": {
      if (!isNumber(raw.id) || !isString(raw.toolId) || !isString(raw.content)) return null;
      return { type: "tool_result", id: raw.id, toolId: raw.toolId, content: raw.content };
    }
    case "subagent_started": {
      if (!isString(raw.taskId) || !isString(raw.description)) return null;
      return { type: "subagent_started", taskId: raw.taskId, description: raw.description };
    }
    case "subagent_progress": {
      if (!isString(raw.taskId) || !isNumber(raw.toolUses) || !isNumber(raw.durationMs) || !isNumber(raw.totalTokens))
        return null;
      return {
        type: "subagent_progress",
        taskId: raw.taskId,
        toolUses: raw.toolUses,
        durationMs: raw.durationMs,
        totalTokens: raw.totalTokens,
      };
    }
    case "subagent_done": {
      if (
        !isString(raw.taskId) ||
        !isString(raw.status) ||
        !VALID_SUBAGENT_STATUS_VALUES.has(raw.status) ||
        !isString(raw.summary) ||
        !isNumber(raw.totalTokens)
      )
        return null;
      return {
        type: "subagent_done",
        taskId: raw.taskId,
        status: raw.status as WsSubagentDone["status"],
        summary: raw.summary,
        totalTokens: raw.totalTokens,
      };
    }
    default:
      return null;
  }
}

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
