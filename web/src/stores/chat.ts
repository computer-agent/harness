import { create } from "zustand";
import type { ChatMessage, ToolCall } from "@/types";

interface ChatStore {
  // Current conversation
  messages: ChatMessage[];
  activeKey: string;
  pendingMessages: string[];
  lastMessageId: number;
  isStreaming: boolean;
  agentStatus: "idle" | "thinking" | "tool_use" | "responding" | "interrupted";

  // Per-session message cache (survives navigation between conversations)
  cache: Record<string, { messages: ChatMessage[]; lastMessageId: number }>;

  switchConversation: (key: string) => void;
  addUserMessage: (content: string) => void;
  startAssistantMessage: () => void;
  appendToken: (text: string, id: number) => void;
  finalizeAssistantMessage: (content: string, id: number) => void;
  addToolCall: (tool: ToolCall) => void;
  updateToolInput: (toolId: string, partialJson: string) => void;
  setStatus: (status: ChatStore["agentStatus"]) => void;
  setStreaming: (v: boolean) => void;
  addError: (message: string) => void;
  clearMessages: () => void;
  updateActiveKey: (key: string) => void;
  loadHistory: (messages: ChatMessage[]) => void;
  queuePendingMessage: (content: string) => void;
  flushPendingMessages: () => string[];
}

function conversationKey(agentId: string, sessionId: string | null): string {
  return sessionId ? `${agentId}:${sessionId}` : `${agentId}:new`;
}

export { conversationKey };

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  activeKey: "",
  pendingMessages: [],
  lastMessageId: 0,
  isStreaming: false,
  agentStatus: "idle",
  cache: {},

  // Save current messages to cache, then load (or init) the target conversation
  switchConversation: (key) => {
    const { activeKey, messages, lastMessageId, cache } = get();

    // Save current conversation to cache (if it has messages)
    const updatedCache = { ...cache };
    if (activeKey && messages.length > 0) {
      updatedCache[activeKey] = { messages, lastMessageId };
    }

    // Load target conversation from cache (or start fresh)
    const cached = updatedCache[key];
    set({
      cache: updatedCache,
      activeKey: key,
      messages: cached?.messages ?? [],
      lastMessageId: cached?.lastMessageId ?? 0,
      isStreaming: false,
      agentStatus: "idle",
    });
  },

  // When the session ID changes (e.g. SDK assigns a real ID), migrate the cache entry
  updateActiveKey: (key) => {
    const { activeKey, messages, lastMessageId, cache } = get();
    if (activeKey === key) return;

    const updatedCache = { ...cache };
    // Remove old key, store under new key
    if (activeKey) delete updatedCache[activeKey];
    updatedCache[key] = { messages, lastMessageId };

    set({ cache: updatedCache, activeKey: key });
  },

  addUserMessage: (content) => {
    const msg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content,
      timestamp: new Date().toISOString(),
    };
    set((s) => ({ messages: [...s.messages, msg] }));
  },

  startAssistantMessage: () => {
    const msg: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
      isStreaming: true,
      toolCalls: [],
    };
    set((s) => ({ messages: [...s.messages, msg], isStreaming: true }));
  },

  appendToken: (text, id) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant") {
        msgs[msgs.length - 1] = { ...last, content: last.content + text, isStreaming: true };
      }
      return { messages: msgs, isStreaming: true, lastMessageId: Math.max(s.lastMessageId, id) };
    });
  },

  finalizeAssistantMessage: (content, id) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant") {
        const toolCalls = last.toolCalls?.map((tc) =>
          tc.status === "executing" ? { ...tc, status: "complete" as const } : tc,
        );
        msgs[msgs.length - 1] = { ...last, content, isStreaming: false, toolCalls };
      }
      // Also persist to cache
      const key = get().activeKey;
      const newLastId = Math.max(s.lastMessageId, id);
      const cache = { ...s.cache, [key]: { messages: msgs, lastMessageId: newLastId } };
      return { messages: msgs, isStreaming: false, lastMessageId: newLastId, cache };
    });
  },

  addToolCall: (tool) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant") {
        const toolCalls = [...(last.toolCalls ?? []), tool];
        msgs[msgs.length - 1] = { ...last, toolCalls };
      }
      return { messages: msgs };
    });
  },

  updateToolInput: (toolId, partialJson) => {
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant" && last.toolCalls) {
        const toolCalls = last.toolCalls.map((tc) =>
          tc.id === toolId ? { ...tc, inputJson: tc.inputJson + partialJson } : tc,
        );
        msgs[msgs.length - 1] = { ...last, toolCalls };
      }
      return { messages: msgs };
    });
  },

  setStatus: (status) => set({ agentStatus: status }),
  setStreaming: (v) => set({ isStreaming: v }),

  addError: (message) => {
    const msg: ChatMessage = {
      id: `error-${Date.now()}`,
      role: "assistant",
      content: message,
      timestamp: new Date().toISOString(),
    };
    set((s) => ({ messages: [...s.messages, msg], isStreaming: false, agentStatus: "idle" }));
  },

  clearMessages: () => set({ messages: [], lastMessageId: 0, isStreaming: false, agentStatus: "idle" }),

  loadHistory: (messages) => {
    const key = get().activeKey;
    const cache = { ...get().cache, [key]: { messages, lastMessageId: get().lastMessageId } };
    set({ messages, cache, isStreaming: false, agentStatus: "idle" });
  },

  queuePendingMessage: (content) => {
    set((s) => ({ pendingMessages: [...s.pendingMessages, content] }));
  },

  flushPendingMessages: () => {
    const pending = get().pendingMessages;
    set({ pendingMessages: [] });
    return pending;
  },
}));
