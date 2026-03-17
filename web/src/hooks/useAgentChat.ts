import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import useWebSocket, { ReadyState } from "react-use-websocket";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { TOKEN_KEY, WS_URL } from "@/lib/constants";
import type { WsClientMsg, WsServerMsg } from "@/lib/ws-client";
import { useAuthStore } from "@/stores/auth";
import { conversationKey, useChatStore } from "@/stores/chat";
import type { ChatMessage, ToolCall } from "@/types";

export type ConnectionState = "connected" | "connecting" | "reconnecting" | "disconnected";

export function useAgentChat(agentId: string | undefined, sessionId: string | null) {
  const { t } = useTranslation();
  let token: string | null = null;
  try {
    token = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // sessionStorage unavailable
  }

  // Use refs to avoid stale closures in WebSocket callbacks
  const agentIdRef = useRef(agentId);
  const sessionIdRef = useRef(sessionId);
  const subscribedRef = useRef(false);
  // Captures the agentId at the time a message was sent, to guard against
  // race conditions when the user switches agents during streaming (FIX-06)
  const sentAgentIdRef = useRef(agentId);

  // Keep refs in sync with props via useEffect (FIX-14)
  useEffect(() => {
    agentIdRef.current = agentId;
  }, [agentId]);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const store = useChatStore();

  const wsUrl = token ? `${WS_URL}?token=${encodeURIComponent(token)}` : null;

  const { sendJsonMessage, readyState, lastJsonMessage } = useWebSocket<WsServerMsg>(wsUrl, {
    shouldReconnect: () => true,
    reconnectAttempts: Infinity,
    reconnectInterval: (attempt: number) => Math.min(1000 * 2 ** attempt, 30000),
    heartbeat: {
      message: JSON.stringify({ type: "ping" }),
      returnMessage: "pong",
      timeout: 60000,
      interval: 25000,
    },
    onOpen: () => {
      subscribedRef.current = false;
      const aid = agentIdRef.current;
      const sid = sessionIdRef.current;
      if (aid) {
        sendSubscribe(aid, sid, useChatStore.getState().lastMessageId);
      }
    },
  });

  const sendSubscribe = useCallback(
    (aid: string, sid: string | null, lastMessageId: number) => {
      const msg: WsClientMsg = {
        type: "subscribe",
        agentId: aid,
        ...(sid ? { sessionId: sid } : {}),
        ...(lastMessageId ? { lastMessageId } : {}),
      };
      sendJsonMessage(msg);
      subscribedRef.current = true;
    },
    [sendJsonMessage],
  );

  // Switch conversation (save old messages, restore cached ones) when agent/session changes
  useEffect(() => {
    const key = conversationKey(agentId ?? "", sessionId);
    store.switchConversation(key);
    subscribedRef.current = false;

    // Fetch persisted history for existing sessions if cache is empty
    if (agentId && sessionId && sessionId !== "new") {
      const cached = store.cache[key];
      if (!cached || cached.messages.length === 0) {
        api
          .get<{ role: string; content: string; timestamp: string; toolCalls?: { name: string; status: string }[] }[]>(
            `/api/sessions/${sessionId}/messages?agent=${encodeURIComponent(agentId)}`,
          )
          .then((persisted) => {
            if (persisted.length === 0) return;
            // Only load if we're still on the same conversation
            if (conversationKey(agentIdRef.current ?? "", sessionIdRef.current) !== key) return;
            const messages: ChatMessage[] = persisted.map((m, i) => ({
              id: `${m.role}-history-${i}`,
              role: m.role as "user" | "assistant",
              content: m.content,
              timestamp: m.timestamp,
              toolCalls: m.toolCalls?.map<ToolCall>((tc, j) => ({
                id: `history-tool-${i}-${j}`,
                name: tc.name,
                inputJson: "",
                status: tc.status as ToolCall["status"],
              })),
            }));
            store.loadHistory(messages);
          })
          .catch(() => {
            // Silently ignore — history fetch is best-effort
          });
      }
    }

    if (agentId && readyState === ReadyState.OPEN) {
      sendSubscribe(agentId, sessionId, useChatStore.getState().lastMessageId);
    }
  }, [agentId, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Process incoming messages
  useEffect(() => {
    if (!lastJsonMessage) return;
    const msg = lastJsonMessage;

    switch (msg.type) {
      case "subscribed":
        if (msg.agentId !== agentIdRef.current) return;
        sessionIdRef.current = msg.sessionId;
        break;

      case "status":
        store.setStatus(msg.status);
        if (msg.status === "thinking") {
          store.startAssistantMessage();
        }
        break;

      case "token":
        store.appendToken(msg.text, msg.id);
        break;

      case "thinking_token":
        store.appendThinkingToken(msg.text);
        break;

      case "tool_use_start":
        store.addToolCall({
          id: msg.toolId,
          name: msg.toolName,
          inputJson: "",
          status: "executing",
        });
        break;

      case "tool_use_input":
        store.updateToolInput(msg.toolId, msg.partialJson);
        break;

      case "assistant_message":
        store.finalizeAssistantMessage(msg.content, msg.id);
        break;

      case "result":
        if (msg.sessionId) {
          sessionIdRef.current = msg.sessionId;
          // Only migrate cache key if the agent hasn't changed since the message was sent (FIX-06)
          if (agentIdRef.current === sentAgentIdRef.current) {
            const realKey = conversationKey(agentIdRef.current ?? "", msg.sessionId);
            store.updateActiveKey(realKey);
          }
        }
        store.setStreaming(false);
        store.setStatus(msg.interrupted ? "interrupted" : "idle");
        break;

      case "error":
        handleWsError(msg.code, msg.message);
        break;

      case "subagent_started":
        store.addSubagentTask(msg.taskId, msg.description);
        break;

      case "subagent_progress":
        store.updateSubagentProgress(msg.taskId, msg.toolUses, msg.durationMs, msg.totalTokens);
        break;

      case "subagent_done":
        store.completeSubagentTask(msg.taskId, msg.status, msg.summary, msg.totalTokens);
        break;

      case "tool_approval":
        store.setToolCallApproval(msg.toolId, msg.question);
        break;

      case "tool_result":
        store.setToolResult(msg.toolId, msg.content);
        break;

      case "replay":
        for (const replayed of msg.messages) {
          if (replayed.type === "token") {
            store.appendToken(replayed.text, replayed.id);
          } else if (replayed.type === "assistant_message") {
            store.finalizeAssistantMessage(replayed.content, replayed.id);
          }
        }
        break;
    }
  }, [lastJsonMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle different WS error codes with appropriate UI feedback
  const handleWsError = useCallback(
    (code: string, message: string) => {
      switch (code) {
        case "session_expired":
          toast.warning(t("errors.sessionExpired"));
          // Auto-create new session: clear sessionId but keep agentId.
          // Old messages remain visible (read-only).
          sessionIdRef.current = null;
          if (agentIdRef.current) {
            sendSubscribe(agentIdRef.current, null, 0);
          }
          break;

        case "auth_failed":
          toast.error(t("errors.authFailed"));
          useAuthStore.getState().clearToken();
          break;

        case "rate_limited": {
          // Extract seconds from message if available (e.g. "retry after 30s")
          const match = message.match(/(\d+)/);
          const seconds = match ? Number.parseInt(match[1], 10) : 60;
          toast.error(t("errors.rateLimited", { seconds }), {
            duration: seconds * 1000,
          });
          const until = Date.now() + seconds * 1000;
          store.setRateLimitedUntil(until);
          store.addError(t("errors.rateLimited", { seconds }), code);
          // Clear rate limit after countdown
          setTimeout(() => {
            useChatStore.getState().setRateLimitedUntil(null);
          }, seconds * 1000);
          break;
        }

        case "model_error":
        case "overloaded":
        case "internal_error":
          // Show as in-chat error with retry capability
          store.addError(message || t("errors.modelError"), code);
          break;

        default:
          // Unknown error codes: show in chat with retry
          store.addError(message || t("errors.modelError"), code);
          break;
      }
    },
    [t, store, sendSubscribe],
  );

  const sendMessage = useCallback(
    (content: string) => {
      if (readyState !== ReadyState.OPEN) {
        store.queuePendingMessage(content);
        return;
      }
      // Block sends during rate limit
      if (store.rateLimitedUntil && Date.now() < store.rateLimitedUntil) {
        const remaining = Math.ceil((store.rateLimitedUntil - Date.now()) / 1000);
        toast.warning(t("errors.rateLimited", { seconds: remaining }));
        return;
      }
      // Capture the agent ID at send time so we can guard the result handler (FIX-06)
      sentAgentIdRef.current = agentIdRef.current;
      store.addUserMessage(content);
      sendJsonMessage({ type: "message", content });
    },
    [readyState, sendJsonMessage, store, t],
  );

  const retryLastMessage = useCallback(() => {
    const content = store.retryLastMessage();
    if (content) {
      sendMessage(content);
    }
  }, [store, sendMessage]);

  const interrupt = useCallback(() => {
    sendJsonMessage({ type: "interrupt" });
  }, [sendJsonMessage]);

  const respondToToolApproval = useCallback(
    (toolId: string, approved: boolean) => {
      sendJsonMessage({ type: "tool_approval", toolId, approved });
      store.updateToolCallStatus(toolId, approved ? "executing" : "error");
    },
    [sendJsonMessage, store],
  );

  const connectionState: ConnectionState =
    readyState === ReadyState.OPEN
      ? "connected"
      : readyState === ReadyState.CONNECTING
        ? subscribedRef.current
          ? "reconnecting"
          : "connecting"
        : "disconnected";

  return {
    messages: store.messages,
    isConnected: readyState === ReadyState.OPEN,
    isStreaming: store.isStreaming,
    agentStatus: store.agentStatus,
    connectionState,
    rateLimitedUntil: store.rateLimitedUntil,
    subagentTasks: store.subagentTasks,
    sendMessage,
    interrupt,
    retryLastMessage,
    respondToToolApproval,
    sessionId: sessionIdRef.current,
  };
}
