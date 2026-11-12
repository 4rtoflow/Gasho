import type { SessionStatus } from "@gasho/protocol";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/format";
import { cn } from "@/lib/utils";

export function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} dot pulse={status === "busy" || status === "waiting"}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

const DOT: Record<SessionStatus, string> = {
  busy: "bg-emerald-500",
  waiting: "bg-amber-500",
  idle: "bg-neutral-500",
  unknown: "bg-neutral-700",
};

/** Small status dot for the sidebar. */
export function StatusDot({ status }: { status: SessionStatus }) {
  return (
    <span className="relative inline-flex size-2.5">
      {(status === "busy" || status === "waiting") && (
        <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", DOT[status])} />
      )}
      <span className={cn("relative inline-flex size-2.5 rounded-full", DOT[status])} />
    </span>
  );
}
