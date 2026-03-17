import { cn } from "@/lib/utils";

type Status = "idle" | "active" | "needs_attention" | "error";

const colors: Record<Status, string> = {
  idle: "bg-zinc-500",
  active: "bg-green-500 status-pulse",
  needs_attention: "bg-orange-500",
  error: "bg-red-500",
};

const statusLabels: Record<Status, string> = {
  idle: "Idle",
  active: "Active",
  needs_attention: "Needs attention",
  error: "Error",
};

export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return (
    <span
      role="img"
      aria-label={statusLabels[status]}
      className={cn("inline-block h-2 w-2 rounded-full", colors[status], className)}
    />
  );
}
