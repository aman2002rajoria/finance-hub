"use client";

import { useCallback, useMemo, useState } from "react";

export function useInteractiveLegend(allCategories: string[]) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [isolated, setIsolated] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const visibleCategories = useMemo(() => {
    if (isolated) return [isolated];
    return allCategories.filter(c => !hidden.has(c));
  }, [allCategories, hidden, isolated]);

  const isVisible = useCallback(
    (cat: string) => visibleCategories.includes(cat),
    [visibleCategories],
  );

  const seriesOpacity = useCallback(
    (cat: string) => {
      if (!highlighted) return 1;
      return cat === highlighted ? 1 : 0.18;
    },
    [highlighted],
  );

  const toggleCategory = useCallback((cat: string) => {
    setIsolated(null);
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  const isolateCategory = useCallback((cat: string) => {
    setIsolated(prev => (prev === cat ? null : cat));
    setHidden(new Set());
  }, []);

  const resetLegend = useCallback(() => {
    setHidden(new Set());
    setIsolated(null);
    setHighlighted(null);
  }, []);

  return {
    hidden,
    isolated,
    highlighted,
    setHighlighted,
    visibleCategories,
    isVisible,
    seriesOpacity,
    toggleCategory,
    isolateCategory,
    resetLegend,
  };
}
