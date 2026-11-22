"use client";

import { useEffect, useRef, useState } from "react";
import { useInView } from "framer-motion";

import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { MOTION } from "@/lib/motion";
import { cn } from "@/lib/utils";

export function NumberTicker({
  value,
  className,
  prefix = "",
  suffix = "",
  decimalPlaces = 0,
  duration = MOTION.ticker,
}: {
  value: number;
  className?: string;
  prefix?: string;
  suffix?: string;
  decimalPlaces?: number;
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px 0px -40px 0px" });
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState(reduced ? value : 0);
  const animated = useRef(false);

  useEffect(() => {
    if (!inView) return;
    if (reduced || animated.current) {
      setDisplay(value);
      return;
    }
    animated.current = true;
    const start = performance.now();
    const from = 0;
    let frame: number;

    const tick = (now: number) => {
      const t = Math.min((now - start) / (duration * 1000), 1);
      const eased = 1 - (1 - t) ** 3;
      setDisplay(from + (value - from) * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inView, value, duration, reduced]);

  useEffect(() => {
    if (reduced) setDisplay(value);
  }, [value, reduced]);

  const formatted =
    decimalPlaces > 0
      ? display.toLocaleString("en-IN", {
          minimumFractionDigits: decimalPlaces,
          maximumFractionDigits: decimalPlaces,
        })
      : Math.round(display).toLocaleString("en-IN");

  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}
