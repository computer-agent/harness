// Re-export shared WS types and provide client-side message helpers

export interface WsSubscribeMsg {
  type: "subscribe";
  agentId: string;
  sessionId?: string;
  lastMessageId?: number;
}

export interface WsMessageMsg {
  type: "message";
  content: string;
}

export interface WsInterruptMsg {
  type: "interrupt";
}

export type WsClientMsg = WsSubscribeMsg | WsMessageMsg | WsInterruptMsg;

// Server message types (matching src/types/ws.ts)
export interface WsConnectedMsg {
  type: "connected";
  connectionId: string;
}

export interface WsSubscribedMsg {
  type: "subscribed";
  agentId: string;
  sessionId: string;
  agentName: string;
  agentDescription: string;
}

export interface WsTokenMsg {
  type: "token";
  id: number;
  text: string;
}

export interface WsToolUseStartMsg {
  type: "tool_use_start";
  id: number;
  toolName: string;
  toolId: string;
}

export interface WsToolUseInputMsg {
  type: "tool_use_input";
  toolId: string;
  partialJson: string;
}

export interface WsAssistantMessageMsg {
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

export interface WsStatusMsg {
  type: "status";
  status: "thinking" | "responding" | "tool_use" | "idle" | "interrupted";
}

export interface WsErrorMsg {
  type: "error";
  code: string;
  message: string;
}

export interface WsResultMsg {
  type: "result";
  sessionId: string;
  interrupted: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

export interface WsSubagentStartedMsg {
  type: "subagent_started";
  taskId: string;
  description: string;
}

export interface WsSubagentProgressMsg {
  type: "subagent_progress";
  taskId: string;
  toolUses: number;
  durationMs: number;
  totalTokens: number;
}

export interface WsSubagentDoneMsg {
  type: "subagent_done";
  taskId: string;
  status: "completed" | "failed" | "stopped";
  summary: string;
  totalTokens: number;
}

export interface WsReplayMsg {
  type: "replay";
  messages: WsServerMsg[];
}

export type WsServerMsg =
  | WsConnectedMsg
  | WsSubscribedMsg
  | WsTokenMsg
  | WsToolUseStartMsg
  | WsToolUseInputMsg
  | WsAssistantMessageMsg
  | WsStatusMsg
  | WsErrorMsg
  | WsResultMsg
  | WsSubagentStartedMsg
  | WsSubagentProgressMsg
  | WsSubagentDoneMsg
  | WsReplayMsg;

// Tool summary generation
export function toolSummary(toolName: string, input?: string): string {
  if (!input) return toolName;
  try {
    const parsed = JSON.parse(input);
    switch (toolName.toLowerCase()) {
      case "read":
        return parsed.file_path ?? parsed.path ?? toolName;
      case "write":
        return parsed.file_path ?? parsed.path ?? toolName;
      case "edit":
        return parsed.file_path ?? parsed.path ?? toolName;
      case "bash":
        return `$ ${(parsed.command ?? "").slice(0, 80)}`;
      case "grep":
        return `"${parsed.pattern ?? ""}" in ${parsed.path ?? "."}`;
      case "glob":
        return parsed.pattern ?? toolName;
      case "websearch":
        return parsed.query ?? toolName;
      case "webfetch":
        return parsed.url ?? toolName;
      default:
        return JSON.stringify(parsed).slice(0, 80);
    }
  } catch {
    return input.slice(0, 80);
  }
}
