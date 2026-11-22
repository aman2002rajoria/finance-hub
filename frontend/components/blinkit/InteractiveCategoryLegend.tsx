"use client";

import clsx from "clsx";

import { categoryColor } from "@/lib/blinkit-category-colors";

/** Clickable legend chips: click to hide, double-click to show only this one. */
export default function InteractiveCategoryLegend({
  categories,
  hidden,
  isolated,
  highlighted,
  onToggle,
  onIsolate,
  onHighlight,
}: {
  categories: string[];
  hidden: Set<string>;
  isolated: string | null;
  highlighted: string | null;
  onToggle: (cat: string) => void;
  onIsolate: (cat: string) => void;
  onHighlight: (cat: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-4">
      {categories.map((cat, i) => {
        const color = categoryColor(cat, i);
        const isHidden = hidden.has(cat) || (isolated != null && isolated !== cat);
        const isIsolated = isolated === cat;
        const isDimmed = highlighted != null && highlighted !== cat;
        return (
          <button
            key={cat}
            type="button"
            aria-pressed={!isHidden}
            title="Click to hide or show. Double-click to show only this one."
            className={clsx(
              "inline-flex items-center gap-2 rounded-pill px-3 py-1 text-[13px] font-medium transition-[background,opacity] duration-200",
              isIsolated ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line)]" : "text-ink-2 hover:bg-surface",
              isHidden ? "opacity-40" : isDimmed ? "opacity-50" : "opacity-100",
            )}
            onClick={() => onToggle(cat)}
            onDoubleClick={(e) => {
              e.preventDefault();
              onIsolate(cat);
            }}
            onMouseEnter={() => onHighlight(cat)}
            onMouseLeave={() => onHighlight(null)}
            onFocus={() => onHighlight(cat)}
            onBlur={() => onHighlight(null)}
          >
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: isHidden ? "transparent" : color, boxShadow: `inset 0 0 0 1.5px ${color}` }}
            />
            <span className={clsx(isHidden && "line-through")}>{cat}</span>
          </button>
        );
      })}
    </div>
  );
}
