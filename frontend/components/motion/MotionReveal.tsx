"use client";

import { motion, type HTMLMotionProps } from "framer-motion";
import type { ReactNode } from "react";

import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { EASE, MOTION, REVEAL, type RevealVariant } from "@/lib/motion";
import { cn } from "@/lib/utils";

type MotionRevealProps = Omit<HTMLMotionProps<"div">, "children"> & {
  children: ReactNode;
  variant?: RevealVariant;
  delay?: number;
  index?: number;
  hoverLift?: boolean;
};

export function MotionReveal({
  children,
  className,
  variant = "card",
  delay = 0,
  index = 0,
  hoverLift: _hoverLift = false,
}: MotionRevealProps) {
  const reduced = usePrefersReducedMotion();
  const v = REVEAL[variant];
  const totalDelay = delay + index * MOTION.stagger;

  if (reduced) {
    return (
      <div className={className}>
        {children}
      </div>
    );
  }

  return (
    <motion.div
      initial={v.hidden}
      whileInView={v.visible}
      viewport={{ once: true, margin: "-60px 0px -40px 0px", amount: 0.12 }}
      transition={{
        duration: variant === "chart" ? MOTION.chart : MOTION.card,
        delay: totalDelay,
        ease: EASE.out,
      }}
      // No hover lift: cards never tilt, glow or scale (design.md §20).
      className={cn(className)}
    >
      {children}
    </motion.div>
  );
}
