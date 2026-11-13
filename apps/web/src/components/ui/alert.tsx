// EasyUI's Alert (easyui.site/components/alert): a message with a tone-aware icon. Taken without the dismiss button,
// which Gasho does not use; an alert that is no longer true is taken off the page instead.
import type { ComponentProps, ReactNode } from "react";
import { CircleAlert, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type AlertTone = "neutral" | "warning" | "danger";

const TONES: Record<AlertTone, { box: string; icon: string; Icon: LucideIcon }> = {
  neutral: { box: "border-neutral-200 bg-neutral-50/70 dark:border-neutral-800 dark:bg-neutral-900/60", icon: "text-neutral-500 dark:text-neutral-400", Icon: Info },
  warning: { box: "border-amber-200 bg-amber-50/70 dark:border-amber-500/30 dark:bg-amber-500/[0.08]", icon: "text-amber-600 dark:text-amber-400", Icon: TriangleAlert },
  danger: { box: "border-red-200 bg-red-50/70 dark:border-red-500/30 dark:bg-red-500/[0.08]", icon: "text-red-600 dark:text-red-400", Icon: CircleAlert },
};

export function Alert({ tone = "neutral", action, className, children, ...props }: ComponentProps<"div"> & { tone?: AlertTone; action?: ReactNode }) {
  const t = TONES[tone];
  return (
    <div
      role={tone === "neutral" ? "status" : "alert"}
      className={cn("flex items-start gap-3 rounded-xl border p-3.5 text-sm", t.box, className)}
      {...props}
    >
      <t.Icon className={cn("mt-0.5 size-4 shrink-0", t.icon)} />
      <div className="min-w-0 flex-1">{children}</div>
      {action && <div className="-my-1 shrink-0">{action}</div>}
    </div>
  );
}

export function AlertTitle({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("font-medium text-neutral-900 dark:text-neutral-100", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-0.5 text-neutral-600 dark:text-neutral-400", className)} {...props} />;
}
