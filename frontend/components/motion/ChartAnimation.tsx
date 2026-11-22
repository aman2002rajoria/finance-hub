"use client";

import {
  createContext, useContext, useMemo, useState,
} from "react";
import { motion } from "framer-motion";

import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { EASE, MOTION } from "@/lib/motion";
import { cn } from "@/lib/utils";

type ChartAnimationCtx = {
  animate: boolean;
  duration: number;
  /** Stagger index for bar groups */
  barDelay: (i: number) => number;
};

const ChartAnimationContext = createContext<ChartAnimationCtx>({
  animate: true,
  duration: 700,
  barDelay: () => 0,
});

export function useChartAnimation() {
  return useContext(ChartAnimationContext);
}

/** Wrap charts — fades container in, then enables Recharts draw animations once. */
export function ChartReveal({
  children,
  className,
  index = 0,
}: {
  children: React.ReactNode;
  className?: string;
  index?: number;
}) {
  const reduced = usePrefersReducedMotion();
  const [chartReady, setChartReady] = useState(reduced);

  const ctx = useMemo<ChartAnimationCtx>(() => ({
    animate: chartReady,
    duration: 700,
    barDelay: (i: number) => i * 40,
  }), [chartReady]);

  if (reduced) {
    return (
      <ChartAnimationContext.Provider value={{ animate: true, duration: 0, barDelay: () => 0 }}>
        <div className={className}>{children}</div>
      </ChartAnimationContext.Provider>
    );
  }

  return (
    <ChartAnimationContext.Provider value={ctx}>
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-50px 0px -30px 0px", amount: 0.15 }}
        transition={{
          duration: MOTION.chart,
          delay: index * MOTION.stagger,
          ease: EASE.out,
        }}
        onViewportEnter={() => setChartReady(true)}
        className={cn(className)}
      >
        {children}
      </motion.div>
    </ChartAnimationContext.Provider>
  );
}

/** Standard Recharts animation props — use on Line, Area, Bar, Pie. */
export function chartAnimProps(index = 0) {
  return {
    isAnimationActive: true,
    animationDuration: 700,
    animationBegin: index * 40,
    animationEasing: "ease-out" as const,
  };
}

/** Hook-friendly props bound to viewport context. */
export function useChartAnimProps(seriesIndex = 0) {
  const { animate, duration, barDelay } = useChartAnimation();
  return {
    isAnimationActive: animate,
    animationDuration: animate ? duration : 0,
    animationBegin: animate ? barDelay(seriesIndex) : 0,
    animationEasing: "ease-out" as const,
  };
}
