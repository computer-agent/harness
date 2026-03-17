// Frontend-specific types

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  icon?: string;
  tags: string[];
  starters: string[];
}

export interface SessionInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  isStreaming?: boolean;
  isError?: boolean;
  errorCode?: string;
  toolCalls?: ToolCall[];
  thinkingContent?: string;
}

export interface SubagentTask {
  taskId: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  toolUses: number;
  durationMs: number;
  totalTokens: number;
  summary?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  inputJson: string;
  output?: string;
  status: "executing" | "complete" | "error";
}
