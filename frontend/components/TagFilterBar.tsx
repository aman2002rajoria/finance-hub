"use client";

import { Segmented } from "@/components/ui";
import type { TagStatusFilter } from "@/lib/types";

const OPTIONS: { value: TagStatusFilter; label: string }[] = [
  { value: "all",      label: "All" },
  { value: "untagged", label: "Untagged" },
  { value: "tagged",   label: "Tagged" },
];

/** Tagged / untagged filter as a segmented control (design.md §7). */
export function TagFilterBar({
  value,
  onChange,
  label = "Filter by tag",
  size = "md",
  counts,
}: {
  value: TagStatusFilter;
  onChange: (v: TagStatusFilter) => void;
  /** Accessible name for the control. */
  label?: string;
  size?: "sm" | "md";
  /** Optional counts shown next to each option. */
  counts?: Partial<Record<TagStatusFilter, number>>;
}) {
  return (
    <Segmented
      ariaLabel={label}
      size={size}
      value={value}
      onChange={onChange}
      options={OPTIONS.map(o => ({
        value: o.value,
        label: counts?.[o.value] != null
          ? <span>{o.label} <span className="tabular-nums text-muted">{counts[o.value]!.toLocaleString("en-IN")}</span></span>
          : o.label,
      }))}
    />
  );
}
