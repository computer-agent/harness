import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ConversationSidebar } from "@/components/sidebar/ConversationSidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import type { AgentInfo } from "@/types";

interface AgentViewProps {
  isNew?: boolean;
}

export function AgentView({ isNew }: AgentViewProps) {
  const { agentId, sessionId: routeSessionId } = useParams<{ agentId: string; sessionId: string }>();
  const navigate = useNavigate();

  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(routeSessionId ?? null);
  const [mobileShowChat, setMobileShowChat] = useState(!!routeSessionId || !!isNew);

  // Fetch agent info
  useEffect(() => {
    if (!agentId) return;
    setLoading(true);
    api
      .get<AgentInfo>(`/api/agents/${agentId}`)
      .then(setAgent)
      .catch(() => navigate("/"))
      .finally(() => setLoading(false));
  }, [agentId, navigate]);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      setSelectedSessionId(sessionId);
      setMobileShowChat(true);
      navigate(`/agent/${agentId}/session/${sessionId}`, { replace: true });
    },
    [agentId, navigate],
  );

  // New chat: open chat panel with no session ID (SDK creates session on first message)
  const handleNewChat = useCallback(() => {
    setSelectedSessionId(null);
    setMobileShowChat(true);
    navigate(`/agent/${agentId}/new`, { replace: true });
  }, [agentId, navigate]);

  const handleBack = useCallback(() => {
    setMobileShowChat(false);
    setSelectedSessionId(null);
    navigate(`/agent/${agentId}`, { replace: true });
  }, [agentId, navigate]);

  if (loading || !agent) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  const showChatPanel = mobileShowChat || selectedSessionId !== null || isNew;

  return (
    <>
      {/* Sidebar — hidden on mobile when chat is shown */}
      <div className={`${mobileShowChat ? "hidden sm:flex" : "flex"} h-full`}>
        <ConversationSidebar
          agent={agent}
          selectedSessionId={selectedSessionId}
          onSelectSession={handleSelectSession}
          onNewChat={handleNewChat}
        />
      </div>

      {/* Chat panel — shown when a session is selected or on new conversation */}
      {showChatPanel && (
        <div className={`${!mobileShowChat ? "hidden sm:flex" : "flex"} relative h-full flex-1`}>
          <ChatPanel agent={agent} sessionId={selectedSessionId} onBack={handleBack} />
        </div>
      )}

      {/* Desktop: show empty state when no session selected */}
      {!showChatPanel && (
        <div className="hidden flex-1 items-center justify-center text-muted-foreground sm:flex">
          <p>Select a conversation or start a new one</p>
        </div>
      )}
    </>
  );
}
