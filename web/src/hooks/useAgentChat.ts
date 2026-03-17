import { useCallback, useEffect, useRef } from "react";
import useWebSocket, { ReadyState } from "react-use-websocket";
import { api } from "@/lib/api";
import { TOKEN_KEY, WS_URL } from "@/lib/constants";
import type { WsClientMsg, WsServerMsg } from "@/lib/ws-client";
import { conversationKey, useChatStore } from "@/stores/chat";
import type { ChatMessage, ToolCall } from "@/types";

export type ConnectionState = "connected" | "connecting" | "reconnecting" | "disconnected";

export function useAgentChat(agentId: string | undefined, sessionId: string | null) {
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
        store.addError(msg.message);
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

  const sendMessage = useCallback(
    (content: string) => {
      if (readyState !== ReadyState.OPEN) {
        store.queuePendingMessage(content);
        return;
      }
      // Capture the agent ID at send time so we can guard the result handler (FIX-06)
      sentAgentIdRef.current = agentIdRef.current;
      store.addUserMessage(content);
      sendJsonMessage({ type: "message", content });
    },
    [readyState, sendJsonMessage, store],
  );

  const interrupt = useCallback(() => {
    sendJsonMessage({ type: "interrupt" });
  }, [sendJsonMessage]);

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
    sendMessage,
    interrupt,
    sessionId: sessionIdRef.current,
  };
}
