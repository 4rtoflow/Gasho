// EasyUI's DrawCheckbox (easyui.site/components/draw-checkbox): a checkbox whose check draws itself and whose box pops
// a little when checked. Taken controlled only, with the box in Gasho's primary color so it shows on both themes.
import { useId, type ReactNode } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export interface DrawCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

const SETTLE = [0.16, 1, 0.3, 1] as const;

export function DrawCheckbox({ checked, onChange, label, description, disabled, className }: DrawCheckboxProps) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-2.5 select-none", disabled && "cursor-not-allowed opacity-40", className)}>
      <span className="relative mt-0.5 flex">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer absolute inset-0 m-0 size-4 cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
        <motion.span
          aria-hidden
          initial={false}
          animate={{ scale: checked ? [0.9, 1.04, 1] : 1 }}
          transition={{ duration: 0.32, ease: SETTLE }}
          className={cn(
            "pointer-events-none flex size-4 items-center justify-center rounded-[4px] border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50",
            checked ? "border-primary bg-primary text-primary-foreground" : "border-border-hover bg-surface-raised",
          )}
        >
          {checked && (
            <motion.svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <motion.path
                d="M3.5 8.5 L6.5 11.5 L12.5 5"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.28, ease: [0.65, 0, 0.35, 1] }}
              />
            </motion.svg>
          )}
        </motion.span>
      </span>
      {(label || description) && (
        <label htmlFor={id} className={cn("min-w-0 cursor-pointer text-left", disabled && "cursor-not-allowed")}>
          {label && <span className="block text-sm leading-tight text-foreground">{label}</span>}
          {description && <span className="mt-0.5 block text-[11px] text-muted-foreground">{description}</span>}
        </label>
      )}
    </div>
  );
}
