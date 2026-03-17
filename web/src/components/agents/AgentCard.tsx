import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { AgentInfo } from "@/types";

interface AgentCardProps {
  agent: AgentInfo;
  onSelect: (agentId: string) => void;
  onStarterClick: (agentId: string, starter: string) => void;
}

export function AgentCard({ agent, onSelect, onStarterClick }: AgentCardProps) {
  const { t: _t } = useTranslation();

  return (
    <Card
      className="cursor-pointer transition-all hover:border-ring hover:shadow-lg active:scale-[0.98]"
      onClick={() => onSelect(agent.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(agent.id);
        }
      }}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <span className="text-2xl" aria-hidden="true">
            {agent.icon ?? "🤖"}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold leading-tight">{agent.name}</h3>
            <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{agent.description}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {agent.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {agent.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        )}
        {agent.starters.length > 0 && (
          <div className="space-y-1">
            {agent.starters.slice(0, 3).map((starter) => (
              <button
                key={starter}
                type="button"
                className="block w-full truncate rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  onStarterClick(agent.id, starter);
                }}
              >
                &gt; {starter}
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
