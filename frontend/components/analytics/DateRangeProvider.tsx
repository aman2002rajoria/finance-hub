"use client";

import {
  createContext, useContext, useEffect, useMemo, useState,
} from "react";

import {
  DATE_RANGE_STORAGE_KEY, defaultDateRange, detectActivePreset, describeRange,
  type PresetMonths,
} from "@/lib/dateRange";
import type { DateRange } from "@/lib/types";

interface DateRangeContextValue {
  dr: DateRange;
  setDr: (next: DateRange | ((prev: DateRange) => DateRange)) => void;
  activePreset: PresetMonths | null;
  isAllTime: boolean;
  subtitle: string;
}

const DateRangeContext = createContext<DateRangeContextValue | null>(null);

export function DateRangeProvider({ children }: { children: React.ReactNode }) {
  const [dr, setDrState] = useState<DateRange>(defaultDateRange);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DATE_RANGE_STORAGE_KEY);
      if (raw) setDrState(JSON.parse(raw) as DateRange);
    } catch { /* keep default */ }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(DATE_RANGE_STORAGE_KEY, JSON.stringify(dr));
  }, [dr, hydrated]);

  const setDr = (next: DateRange | ((prev: DateRange) => DateRange)) => {
    setDrState(prev => (typeof next === "function" ? next(prev) : next));
  };

  const activePreset = useMemo(() => detectActivePreset(dr), [dr]);
  const isAllTime = !dr.date_from && !dr.date_to;
  const subtitle = describeRange(dr, activePreset);

  const value = useMemo(
    () => ({ dr, setDr, activePreset, isAllTime, subtitle }),
    [dr, activePreset, isAllTime, subtitle],
  );

  return (
    <DateRangeContext.Provider value={value}>
      {children}
    </DateRangeContext.Provider>
  );
}

export function useDateRange(): DateRangeContextValue {
  const ctx = useContext(DateRangeContext);
  if (!ctx) throw new Error("useDateRange must be used within DateRangeProvider");
  return ctx;
}
