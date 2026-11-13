// EasyUI's Button (easyui.site/components/button): a button with a spring tap and a loading spinner. Taken with the
// variants and sizes Gasho uses, and its colors moved onto Gasho's tokens.
import { forwardRef, type ReactNode } from "react";
import { motion, type HTMLMotionProps } from "framer-motion";
import { Loader2 } from "lucide-react";
import { motionTransitions } from "@/lib/motion-tokens";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner in place of the left icon and disables the button. */
  isLoading?: boolean;
  /** Shown instead of the children while loading. */
  loadingText?: string;
  leftIcon?: ReactNode;
  children?: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "border border-transparent bg-primary text-primary-foreground hover:opacity-90",
  secondary: "border border-border bg-surface text-foreground hover:border-border-hover hover:bg-surface-hover",
  ghost: "border border-transparent text-muted-foreground hover:bg-surface-hover hover:text-foreground",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 rounded-md px-3 text-xs [&_svg]:size-3.5",
  md: "h-10 gap-2 rounded-lg px-4 text-sm [&_svg]:size-4",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", isLoading = false, loadingText, leftIcon, disabled, className, children, type = "button", ...props },
  ref,
) {
  const off = disabled || isLoading;
  return (
    <motion.button
      ref={ref}
      type={type}
      disabled={off}
      whileTap={off ? undefined : { scale: 0.97 }}
      transition={motionTransitions.springSnappy}
      aria-busy={isLoading}
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer items-center justify-center font-medium whitespace-nowrap transition-colors duration-150 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50",
        VARIANTS[variant],
        SIZES[size],
        off && "pointer-events-none opacity-40",
        className,
      )}
      {...props}
    >
      {isLoading ? <Loader2 className="shrink-0 animate-spin" /> : leftIcon && <span className="inline-flex shrink-0">{leftIcon}</span>}
      {isLoading && loadingText ? <span>{loadingText}</span> : children && <span>{children}</span>}
    </motion.button>
  );
});
