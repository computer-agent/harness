import { ChevronDown, ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ReconnectBanner } from "@/components/shared/ReconnectBanner";
import { StatusDot } from "@/components/shared/StatusDot";
import { Button } from "@/components/ui/button";
import { type ConnectionState, useAgentChat } from "@/hooks/useAgentChat";
import type { AgentInfo } from "@/types";
import { InputArea } from "./InputArea";
import { MessageBubble } from "./MessageBubble";

interface ChatPanelProps {
  agent: AgentInfo;
  sessionId: string | null;
  onBack?: () => void;
}

export function ChatPanel({ agent, sessionId, onBack }: ChatPanelProps) {
  const { t } = useTranslation();
  const {
    messages,
    isStreaming,
    connectionState,
    rateLimitedUntil,
    sendMessage,
    interrupt,
    retryLastMessage,
    respondToToolApproval,
  } = useAgentChat(agent.id, sessionId);

  const isRateLimited = rateLimitedUntil !== null && Date.now() < rateLimitedUntil;

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  // Auto-scroll
  useEffect(() => {
    if (!userScrolledUp) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, userScrolledUp]);

  // Detect manual scroll
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    setUserScrolledUp(!isNearBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setUserScrolledUp(false);
  }, []);

  const connectionStatus: "idle" | "active" | "error" =
    connectionState === "connected" ? "idle" : connectionState === "disconnected" ? "error" : "active";

  // Empty state
  const isEmpty = messages.length === 0;

  return (
    <div className="flex h-full flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        {onBack && (
          <Button variant="ghost" size="icon" onClick={onBack} className="sm:hidden" aria-label={t("common.back")}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
        )}
        <span className="text-lg" aria-hidden="true">
          {agent.icon ?? "🤖"}
        </span>
        <span className="flex-1 truncate font-semibold">{agent.name}</span>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot status={connectionStatus} />
          <span className="hidden sm:inline">{t(`connection.${connectionState}`)}</span>
        </div>
      </div>

      {/* Reconnect banner */}
      <ReconnectBanner state={connectionState as ConnectionState} />

      {/* Messages */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
        role="log"
        aria-live="polite"
      >
        {isEmpty ? (
          <EmptyState agent={agent} onStarterClick={sendMessage} />
        ) : (
          <div className="py-4">
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                onRetry={msg.isError ? retryLastMessage : undefined}
                onToolApproval={respondToToolApproval}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Scroll to bottom */}
      {userScrolledUp && (
        <div className="absolute bottom-20 right-6">
          <Button
            variant="secondary"
            size="icon"
            className="rounded-full shadow-lg"
            onClick={scrollToBottom}
            aria-label={t("chat.scrollToBottom")}
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Input */}
      <InputArea
        onSend={sendMessage}
        onInterrupt={interrupt}
        isStreaming={isStreaming}
        disabled={connectionState !== "connected" || isRateLimited}
      />
    </div>
  );
}

function EmptyState({ agent, onStarterClick }: { agent: AgentInfo; onStarterClick: (s: string) => void }) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col items-center justify-center p-6 text-center">
      <span className="mb-3 text-5xl" aria-hidden="true">
        {agent.icon ?? "🤖"}
      </span>
      <h2 className="mb-1 text-lg font-semibold">{agent.name}</h2>
      <p className="mb-6 max-w-sm text-sm text-muted-foreground">{agent.description}</p>

      {agent.starters.length > 0 && (
        <div className="w-full max-w-sm space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t("chat.starters")}</p>
          {agent.starters.map((starter) => (
            <Button
              key={starter}
              variant="outline"
              className="w-full justify-start text-left text-sm"
              onClick={() => onStarterClick(starter)}
            >
              {starter}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
