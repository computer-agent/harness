import { Check, ChevronDown, ChevronRight, Loader2, ShieldQuestion, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { toolSummary } from "@/lib/ws-client";
import type { ToolCall } from "@/types";

const borderColors = {
  executing: "border-l-blue-500",
  complete: "border-l-green-500",
  error: "border-l-red-500",
  needs_approval: "border-l-orange-500",
};

const statusIcons = {
  executing: <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />,
  complete: <Check className="h-3.5 w-3.5 text-green-400" />,
  error: <X className="h-3.5 w-3.5 text-red-400" />,
  needs_approval: <ShieldQuestion className="h-3.5 w-3.5 text-orange-400" />,
};

export function ToolCallBlock({
  toolCall,
  onApprove,
  onDeny,
}: {
  toolCall: ToolCall;
  onApprove?: (toolId: string) => void;
  onDeny?: (toolId: string) => void;
}) {
  const { t: _t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const canExpand = toolCall.status !== "executing";
  const summary = toolSummary(toolCall.name, toolCall.inputJson);

  return (
    <Collapsible open={expanded} onOpenChange={canExpand ? setExpanded : undefined}>
      <CollapsibleTrigger
        className={cn(
          "my-1.5 flex w-full items-center gap-2 rounded-md border-l-2 bg-secondary/50 px-3 py-2 text-left text-xs transition-colors",
          borderColors[toolCall.status],
          canExpand && "cursor-pointer hover:bg-accent",
        )}
        disabled={!canExpand}
      >
        {statusIcons[toolCall.status]}
        <span className="font-semibold uppercase tracking-wide text-muted-foreground">{toolCall.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>
        {canExpand &&
          (expanded ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          ))}
      </CollapsibleTrigger>
      {toolCall.status === "needs_approval" && (
        <div className="my-1.5 ml-6 flex items-center gap-2">
          {toolCall.question && <span className="text-xs text-orange-300">{toolCall.question}</span>}
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-xs text-green-400 border-green-500/30 hover:bg-green-950/20"
            onClick={() => onApprove?.(toolCall.id)}
          >
            <Check className="h-3 w-3" />
            Allow
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-xs text-red-400 border-red-500/30 hover:bg-red-950/20"
            onClick={() => onDeny?.(toolCall.id)}
          >
            <X className="h-3 w-3" />
            Deny
          </Button>
        </div>
      )}
      <CollapsibleContent>
        <div className="mb-1.5 ml-2 space-y-2 border-l-2 border-border pl-4 text-xs">
          {toolCall.inputJson && (
            <div>
              <p className="mb-1 font-semibold text-muted-foreground">Input:</p>
              <pre className="overflow-x-auto rounded-md bg-card p-2 text-foreground">
                {formatJson(toolCall.inputJson)}
              </pre>
            </div>
          )}
          {toolCall.output !== undefined && <ToolOutput output={toolCall.output} />}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolOutput({ output }: { output: string }) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const truncated = output.length > 500 && !showAll;

  return (
    <div>
      <p className="mb-1 font-semibold text-muted-foreground">Output:</p>
      <pre className="overflow-x-auto rounded-md bg-card p-2 text-foreground">
        {truncated ? `${output.slice(0, 500)}...` : output}
      </pre>
      {output.length > 500 && (
        <button
          type="button"
          className="mt-1 text-xs text-blue-400 hover:underline"
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? t("chat.showLess") : t("chat.showMore")}
        </button>
      )}
    </div>
  );
}

function formatJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}
