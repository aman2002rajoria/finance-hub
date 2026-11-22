"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";

import { EASE, MOTION } from "@/lib/motion";

export type PillItem = {
  id: string;
  label: string;
  href?: string;
  Icon?: LucideIcon;
  onClick?: () => void;
};

export function AnimatedPills({
  items,
  activeId,
  layoutId = "pill-indicator",
  className,
}: {
  items: PillItem[];
  activeId: string;
  layoutId?: string;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "relative inline-flex max-w-full flex-wrap gap-1 rounded-pill bg-surface p-1",
        className,
      )}
    >
      {items.map(item => {
        const active = item.id === activeId;
        const inner = (
          <>
            {active && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-pill bg-card shadow-[0_0_0_1px_var(--line),0_1px_0_var(--surface-2)]"
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
              />
            )}
            {item.Icon && (
              <item.Icon
                className={clsx(
                  "relative z-10 h-4 w-4 shrink-0 transition-colors duration-200",
                  active ? "text-ink" : "text-muted",
                )}
              />
            )}
            <span
              className={clsx(
                "relative z-10 text-sm font-semibold transition-colors duration-200",
                active ? "text-ink" : "text-muted group-hover:text-ink",
              )}
            >
              {item.label}
            </span>
          </>
        );

        const pillClass = clsx(
          "group relative flex items-center gap-2 rounded-pill px-4 py-2",
          "transition-[color,transform] duration-200 active:scale-[.94]",
        );

        if (item.href) {
          return (
            <Link key={item.id} href={item.href} className={pillClass}>
              {inner}
            </Link>
          );
        }

        return (
          <button
            key={item.id}
            type="button"
            onClick={item.onClick}
            className={pillClass}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}

/** Segmented control variant — compact, for chart view toggles. */
export function AnimatedSegmentedControl<T extends string>({
  options,
  value,
  onChange,
  layoutId = "segment-indicator",
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  layoutId?: string;
}) {
  return (
    <div className="relative inline-flex rounded-pill bg-surface p-1">
      {options.map(opt => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className={clsx(
              "relative rounded-pill px-3 py-1.5 text-[13px] font-semibold transition-[color,transform] duration-200 active:scale-[.94]",
              active ? "text-ink" : "text-muted hover:text-ink",
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-pill bg-card shadow-[0_0_0_1px_var(--line),0_1px_0_var(--surface-2)]"
                transition={{ duration: MOTION.ui, ease: EASE.inOut }}
              />
            )}
            <span className="relative z-10">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
