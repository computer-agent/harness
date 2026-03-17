import { Loader2, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConnectionState } from "@/hooks/useAgentChat";

export function ReconnectBanner({ state }: { state: ConnectionState }) {
  const { t } = useTranslation();

  if (state === "connected") return null;

  const isReconnecting = state === "reconnecting" || state === "connecting";

  return (
    <div
      role="status"
      aria-live="assertive"
      className={cn(
        "flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium",
        isReconnecting ? "bg-amber-600/20 text-amber-400" : "bg-red-600/20 text-red-400",
      )}
    >
      {isReconnecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <WifiOff className="h-3 w-3" />}
      {t(`connection.${state}`)}
    </div>
  );
}

function cn(...classes: (string | undefined | false)[]) {
  return classes.filter(Boolean).join(" ");
}
