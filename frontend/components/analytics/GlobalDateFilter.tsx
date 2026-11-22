"use client";

import clsx from "clsx";
import { useEffect, useState } from "react";

import { Segmented, Select } from "@/components/ui";
import { lastNMonths, PRESET_MONTHS } from "@/lib/dateRange";

import { useDateRange } from "./DateRangeProvider";

type RangeKey = "1" | "3" | "6" | "12" | "all" | "custom";

const OPTIONS: { value: RangeKey; label: string; long: string }[] = [
  ...PRESET_MONTHS.map(n => ({
    value: String(n) as RangeKey,
    label: `${n}M`,
    long: n === 1 ? "Last month" : `Last ${n} months`,
  })),
  { value: "all", label: "All", long: "All time" },
  { value: "custom", label: "Custom", long: "Custom dates" },
];

/**
 * Date range control (design.md §7): a segmented control for the presets
 * plus a compact from/to pair when "Custom" is picked. Under 640px the six
 * pills don't fit, so it becomes a select with full labels.
 */
export default function GlobalDateFilter({ className }: { className?: string }) {
  const { dr, setDr, activePreset, isAllTime } = useDateRange();
  const isCustom = !isAllTime && activePreset === null;
  const [showCustom, setShowCustom] = useState(isCustom);

  useEffect(() => {
    if (isCustom) setShowCustom(true);
  }, [isCustom]);

  const value: RangeKey = showCustom || isCustom
    ? "custom"
    : isAllTime
      ? "all"
      : (String(activePreset) as RangeKey);

  function onChange(next: RangeKey) {
    if (next === "custom") {
      setShowCustom(true);
      return;
    }
    setShowCustom(false);
    if (next === "all") setDr({});
    else setDr(lastNMonths(Number(next)));
  }

  return (
    <div className={clsx("flex flex-wrap items-center gap-3", className)}>
      <Segmented<RangeKey>
        className="!hidden sm:!inline-flex"
        ariaLabel="Date range"
        options={OPTIONS}
        value={value}
        onChange={onChange}
      />
      <Select
        aria-label="Date range"
        value={value}
        onChange={e => onChange(e.target.value as RangeKey)}
        className="!w-auto min-w-[200px] font-semibold sm:hidden"
      >
        {OPTIONS.map(o => <option key={o.value} value={o.value}>{o.long}</option>)}
      </Select>
      {value === "custom" && (
        <div className="flex flex-wrap items-center gap-2 rounded-pill bg-surface p-1 pl-1">
          <DateField
            label="From"
            value={dr.date_from}
            max={dr.date_to}
            onChange={v => setDr(prev => ({ ...prev, date_from: v }))}
          />
          <span className="text-sm text-muted" aria-hidden>to</span>
          <DateField
            label="To"
            value={dr.date_to}
            min={dr.date_from}
            onChange={v => setDr(prev => ({ ...prev, date_to: v }))}
          />
        </div>
      )}
    </div>
  );
}

function DateField({
  label, value, min, max, onChange,
}: {
  label: string;
  value?: string;
  min?: string;
  max?: string;
  onChange: (v: string | undefined) => void;
}) {
  return (
    <input
      type="date"
      aria-label={label}
      value={value || ""}
      min={min}
      max={max}
      onChange={e => onChange(e.target.value || undefined)}
      className={clsx(
        "h-9 rounded-pill bg-card px-3 text-sm font-medium tabular-nums text-ink",
        "shadow-[0_0_0_1px_var(--line)] transition-shadow",
        "focus:outline-none focus:shadow-[0_0_0_2px_var(--accent-500),0_0_0_6px_var(--accent-100)]",
      )}
    />
  );
}
