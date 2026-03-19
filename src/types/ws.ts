// ─── Client → Server ───
// W8-T07: WsClientMessage is derived from the Zod schema in ws-protocol.ts (single source of truth).
// Re-exported here so existing imports from types/ws.ts continue to work.
export type { WsClientMessage } from "../ws-protocol.js";

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
  // W8.1-T05/T15: Optional retry-after hint for rate-limited clients
  retryAfter?: number;
}

export interface WsStatus {
  type: "status";
  status: "thinking" | "responding" | "tool_use" | "idle" | "interrupted";
}

export interface WsResult {
  type: "result";
  sessionId: string | null;
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

// Budget messages
export interface WsBudgetWarning {
  type: "budget_warning";
  warnings: Array<{
    budget: "session" | "daily" | "monthly";
    limit: number;
    used: number;
    percentage: number;
  }>;
}

export interface WsBudgetExceeded {
  type: "budget_exceeded";
  reason: "session" | "daily" | "monthly";
  limit: number;
  used: number;
  resetsAt?: string;
}

export interface WsConsentRequired {
  type: "consent_required";
  policyVersion: string;
}

export interface WsToolApprovalRejected {
  type: "tool_approval_rejected";
  toolId: string;
  reason: string;
}

export interface WsRosterUpdated {
  type: "roster_updated";
  agents: Array<{
    id: string;
    name: string;
    description: string;
    icon?: string;
    tags: string[];
    starters: string[];
  }>;
}

// W8.1-T05: New types for protocol completeness
export interface WsWarning {
  type: "warning";
  code: string;
  message: string;
}

export interface WsPong {
  type: "pong";
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
  | WsReplay
  | WsBudgetWarning
  | WsBudgetExceeded
  | WsConsentRequired
  | WsRosterUpdated
  | WsToolApprovalRejected
  | WsWarning
  | WsPong;
