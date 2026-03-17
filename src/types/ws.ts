// ─── Client → Server ───

export interface WsSubscribe {
  type: "subscribe";
  agentId: string;
  sessionId?: string; // Omit for new conversation; provide to resume
  lastMessageId?: number; // For reconnection: replay messages after this ID
}

export interface WsMessage {
  type: "message";
  content: string;
}

export interface WsInterrupt {
  type: "interrupt";
}

export interface WsPing {
  type: "ping";
}

export interface WsToolApprovalResponse {
  type: "tool_approval";
  toolId: string;
  approved: boolean;
}

export type WsClientMessage = WsSubscribe | WsMessage | WsInterrupt | WsPing | WsToolApprovalResponse;

// ─── Server → Client ───

export interface WsConnected {
  type: "connected";
  connectionId: string;
}

export interface WsSubscribed {
  type: "subscribed";
  agentId: string;
  sessionId: string;
  agentName: string;
  agentDescription: string;
}

export interface WsToken {
  type: "token";
  id: number;
  text: string;
}

export interface WsThinkingToken {
  type: "thinking_token";
  text: string;
}

export interface WsToolUseStart {
  type: "tool_use_start";
  id: number;
  toolName: string;
  toolId: string;
}

export interface WsToolUseInput {
  type: "tool_use_input";
  toolId: string;
  partialJson: string;
}

export interface WsToolUseEnd {
  type: "tool_use_end";
  toolId: string;
  input: Record<string, unknown>;
}

export interface WsToolResult {
  type: "tool_result";
  id: number;
  toolId: string;
  content: string;
}

export interface WsAssistantMessage {
  type: "assistant_message";
  id: number;
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}

export interface WsSubagentStarted {
  type: "subagent_started";
  taskId: string;
  description: string;
}

export interface WsSubagentProgress {
  type: "subagent_progress";
  taskId: string;
  toolUses: number;
  durationMs: number;
  totalTokens: number;
}

export interface WsSubagentDone {
  type: "subagent_done";
  taskId: string;
  status: "completed" | "failed" | "stopped";
  summary: string;
  totalTokens: number;
}

export interface WsError {
  type: "error";
  code: string;
  message: string;
}

export interface WsStatus {
  type: "status";
  status: "thinking" | "responding" | "tool_use" | "idle" | "interrupted";
}

export interface WsResult {
  type: "result";
  sessionId: string;
  interrupted: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalCostUsd?: number;
    durationMs?: number;
  };
}

export interface WsToolApprovalRequest {
  type: "tool_approval";
  toolId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  question: string;
}

export interface WsReplay {
  type: "replay";
  messages: WsServerMessage[];
}

export type WsServerMessage =
  | WsConnected
  | WsSubscribed
  | WsToken
  | WsThinkingToken
  | WsToolUseStart
  | WsToolUseInput
  | WsToolUseEnd
  | WsToolResult
  | WsAssistantMessage
  | WsSubagentStarted
  | WsSubagentProgress
  | WsSubagentDone
  | WsError
  | WsStatus
  | WsResult
  | WsToolApprovalRequest
  | WsReplay;
