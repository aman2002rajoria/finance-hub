"use client";

import { Card } from "@/components/ui";
import { ChartReveal } from "@/components/motion/ChartAnimation";
import { cn } from "@/lib/utils";

/** Chart card with viewport-triggered entrance + inner chart draw animation. */
export function MotionChartCard({
  children,
  className,
  index = 0,
  padded = true,
}: {
  children: React.ReactNode;
  className?: string;
  index?: number;
  padded?: boolean;
}) {
  return (
    <ChartReveal index={index}>
      <Card motion motionIndex={index} hoverLift padded={padded} className={cn(className)}>
        {children}
      </Card>
    </ChartReveal>
  );
}

/** Table / list section fade-in */
export function MotionTableSection({
  children,
  className,
  index = 0,
}: {
  children: React.ReactNode;
  className?: string;
  index?: number;
}) {
  return (
    <ChartReveal index={index}>
      <div className={className}>{children}</div>
    </ChartReveal>
  );
}
