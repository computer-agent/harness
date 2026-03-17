import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentRoster } from "@/hooks/useAgentRoster";
import { AgentCard } from "./AgentCard";

export function AgentGrid() {
  const { t } = useTranslation();
  const { agents, isLoading, error, refetch } = useAgentRoster();
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div className="p-6">
        <h2 className="mb-6 text-xl font-semibold">{t("agents.chooseAgent")}</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-52 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center p-6">
        <Alert variant="destructive" className="max-w-md">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t("common.error")}</AlertTitle>
          <AlertDescription className="mt-2">
            {error}
            <Button variant="outline" size="sm" className="mt-3" onClick={refetch}>
              {t("errors.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-muted-foreground">{t("agents.noAgents")}</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h2 className="mb-6 text-xl font-semibold">{t("agents.chooseAgent")}</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            onSelect={(id) => navigate(`/agent/${id}`)}
            onStarterClick={(id, starter) => navigate(`/agent/${id}/new?starter=${encodeURIComponent(starter)}`)}
          />
        ))}
      </div>
    </div>
  );
}
