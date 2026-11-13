// EasyUI's Skeleton (easyui.site/components/skeleton): a placeholder block with a slow light sweep. Size it with
// className.
import type { ComponentProps } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div aria-hidden className={cn("relative overflow-hidden rounded-md bg-neutral-200/70 dark:bg-neutral-800/70", className)} {...props}>
      <motion.div
        className="absolute inset-0 bg-[linear-gradient(90deg,transparent,var(--sk),transparent)] [--sk:rgb(255_255_255/0.65)] dark:[--sk:rgb(255_255_255/0.07)]"
        initial={{ x: "-100%" }}
        animate={{ x: "100%" }}
        transition={{ duration: 1.6, ease: "easeInOut", repeat: Infinity }}
      />
    </div>
  );
}
