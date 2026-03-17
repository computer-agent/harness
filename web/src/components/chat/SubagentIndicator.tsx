import { CheckCircle, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SubagentTask } from "@/types";

export function SubagentIndicator({ task }: { task: SubagentTask }) {
  const elapsed = task.durationMs > 0 ? `${(task.durationMs / 1000).toFixed(1)}s` : "";

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs",
        task.status === "running" && "border-blue-500/30 bg-blue-950/20 text-blue-300",
        task.status === "completed" && "border-green-500/30 bg-green-950/20 text-green-300",
        (task.status === "failed" || task.status === "stopped") && "border-red-500/30 bg-red-950/20 text-red-300",
      )}
    >
      {task.status === "running" && <Loader2 className="h-3 w-3 animate-spin" />}
      {task.status === "completed" && <CheckCircle className="h-3 w-3" />}
      {(task.status === "failed" || task.status === "stopped") && <XCircle className="h-3 w-3" />}

      <span className="flex-1 truncate">{task.description}</span>

      {elapsed && <span className="text-muted-foreground">{elapsed}</span>}
      {task.toolUses > 0 && <span className="text-muted-foreground">{task.toolUses} tools</span>}
      {task.summary && task.status !== "running" && (
        <span className="ml-1 max-w-[200px] truncate text-muted-foreground" title={task.summary}>
          {task.summary}
        </span>
      )}
    </div>
  );
}
