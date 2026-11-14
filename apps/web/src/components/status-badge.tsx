import type { SessionStatus } from "@gasho/protocol";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A session's state. Working and idle show the dot alone, told apart by its color and by its ping while the session
 * works; their words are left to screen readers and the tooltip. Waiting for an answer, and a state Gasho cannot
 * tell, keep their words.
 */
export function StatusBadge({ status }: { status: SessionStatus }) {
  if (status === "busy" || status === "idle") {
    return (
      // As tall as the badge, so what is beside it does not move when the state changes.
      <span role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]} className="inline-flex h-6 shrink-0 items-center">
        <StatusDot status={status} />
      </span>
    );
  }
  return (
    <Badge tone={STATUS_TONE[status]} dot pulse={status === "waiting"}>
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

/** Small status dot, for the sidebar and for the states that show no words. */
export function StatusDot({ status }: { status: SessionStatus }) {
  return (
    <span className="relative inline-flex size-2.5">
      {(status === "busy" || status === "waiting") && (
        <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none", DOT[status])} />
      )}
      <span className={cn("relative inline-flex size-2.5 rounded-full", DOT[status])} />
    </span>
  );
}
