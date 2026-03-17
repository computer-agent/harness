import { Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { SessionInfo } from "@/types";

interface ConversationItemProps {
  session: SessionInfo;
  isSelected: boolean;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}

function relativeTime(isoDate: string, locale: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  if (seconds < 60) return locale.startsWith("pt") ? "Agora mesmo" : "Just now";
  if (minutes < 60) return rtf.format(-minutes, "minute");
  if (hours < 24) return rtf.format(-hours, "hour");
  if (days < 7) return rtf.format(-days, "day");
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(isoDate));
}

export function ConversationItem({ session, isSelected, onSelect, onDelete }: ConversationItemProps) {
  const { i18n } = useTranslation();
  const [swipeX, setSwipeX] = useState(0);
  const touchStartRef = useRef(0);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartRef.current = e.touches[0].clientX;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const diff = touchStartRef.current - e.touches[0].clientX;
    if (diff > 0) setSwipeX(Math.min(diff, 80));
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (swipeX > 50) {
      setSwipeX(80);
    } else {
      setSwipeX(0);
    }
  }, [swipeX]);

  return (
    <li className="group relative list-none overflow-hidden">
      {/* Delete button behind (mobile swipe) */}
      <div className="absolute inset-y-0 right-0 flex w-20 items-center justify-center bg-red-600">
        <button
          type="button"
          className="flex h-full w-full items-center justify-center"
          onClick={() => onDelete(session.id)}
          aria-label={`Delete ${session.name}`}
        >
          <Trash2 className="h-4 w-4 text-white" />
        </button>
      </div>

      {/* Main content */}
      <button
        type="button"
        className={cn(
          "relative flex w-full cursor-pointer items-center gap-3 bg-background px-4 py-3 pr-10 text-left transition-all hover:bg-accent",
          isSelected && "bg-accent",
        )}
        style={{ transform: `translateX(-${swipeX}px)` }}
        onClick={() => onSelect(session.id)}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-medium">{session.name || "New conversation"}</p>
            <span className="shrink-0 text-xs text-muted-foreground">
              {relativeTime(session.lastUsedAt || session.createdAt, i18n.language)}
            </span>
          </div>
        </div>
      </button>

      {/* Desktop delete on hover — positioned outside the select button */}
      <button
        type="button"
        className="absolute right-2 top-1/2 hidden -translate-y-1/2 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 sm:block"
        onClick={() => onDelete(session.id)}
        aria-label={`Delete ${session.name}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
