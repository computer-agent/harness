import { ChevronLeft, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSessions } from "@/hooks/useSessions";
import type { AgentInfo } from "@/types";
import { ConversationItem } from "./ConversationItem";

interface ConversationSidebarProps {
  agent: AgentInfo;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewChat: () => void;
}

export function ConversationSidebar({
  agent,
  selectedSessionId,
  onSelectSession,
  onNewChat,
}: ConversationSidebarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sessions, isLoading, deleteSession } = useSessions(agent.id);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const handleDelete = async () => {
    if (deleteTarget) {
      await deleteSession(deleteTarget);
      setDeleteTarget(null);
    }
  };

  return (
    <div className="flex h-full w-full flex-col border-r border-border sm:w-80">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border p-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/")} aria-label={t("common.back")}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="flex-1 truncate text-sm font-semibold">{agent.name}</span>
        <Button variant="ghost" size="icon" onClick={onNewChat} aria-label={t("conversations.newChat")}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Session list */}
      <ul className="flex-1 list-none overflow-y-auto">
        {isLoading ? (
          <li className="space-y-2 p-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </li>
        ) : sessions.length === 0 ? (
          <li className="p-6 text-center text-sm text-muted-foreground">{t("conversations.noConversations")}</li>
        ) : (
          sessions.map((session) => (
            <ConversationItem
              key={session.id}
              session={session}
              isSelected={session.id === selectedSessionId}
              onSelect={onSelectSession}
              onDelete={setDeleteTarget}
            />
          ))
        )}
      </ul>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogTrigger className="hidden" />
        <AlertDialogContent>
          <AlertDialogTitle>{t("conversations.deleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("conversations.deleteDescription")}</AlertDialogDescription>
          <div className="flex justify-end gap-2">
            <AlertDialogCancel>{t("conversations.deleteCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">
              {t("conversations.deleteConfirm")}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
