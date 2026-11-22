"use client";

/*
 * Motion lab kit: the §14 curves as JS easings, a tween hook, and the
 * numbered section / option frames used by /lab/motion.
 */

import clsx from "clsx";
import { animate, useInView } from "framer-motion";
import { RotateCcw } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";


// ---------------------------------------------------------------------------
// Curves (design.md §14). The spring is the same linear() the CSS uses.
// ---------------------------------------------------------------------------

const SPRING_POINTS: [number, number][] = [
  [0, 0], [0.044, 0.096], [0.095, 0.355], [0.161, 0.705], [0.203, 0.877], [0.247, 1.004],
  [0.291, 1.074], [0.336, 1.098], [0.386, 1.09], [0.497, 1.035], [0.607, 1.003], [0.721, 0.996], [1, 1],
];

/** JS version of `--spring` for framer-motion. */
export function spring(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  for (let i = 1; i < SPRING_POINTS.length; i++) {
    const [x1, y1] = SPRING_POINTS[i];
    if (t <= x1) {
      const [x0, y0] = SPRING_POINTS[i - 1];
      return y0 + ((t - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return 1;
}

/** `--soft`: cubic-bezier(.22,1,.36,1). */
export const SOFT = [0.22, 1, 0.36, 1] as const;

/**
 * Reduced-motion preference, read synchronously on first render. Options
 * only mount on the client (after the section is in view), so framer's
 * `initial` already uses the right variant; the shared hook starts at false.
 */
export function useReduced(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    setReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

export function formatINR(n: number): string {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}

/**
 * Tween a number towards `target`. Starts at `from` (default: target, so no
 * animation on first render unless `from` is given). Reduced motion: jumps.
 */
export function useTween(
  target: number,
  { from, duration = 0.8, ease = SOFT as unknown as number[], onDone }: {
    from?: number; duration?: number; ease?: number[] | ((t: number) => number); onDone?: () => void;
  } = {},
): number {
  const reduced = useReduced();
  const [value, setValue] = useState(from ?? target);
  const current = useRef(from ?? target);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    if (reduced) {
      current.current = target;
      setValue(target);
      done.current?.();
      return;
    }
    const controls = animate(current.current, target, {
      duration,
      ease: ease as never,
      onUpdate: v => {
        current.current = v;
        setValue(v);
      },
      onComplete: () => done.current?.(),
    });
    return () => controls.stop();
  }, [target, duration, ease, reduced]);

  return value;
}

// ---------------------------------------------------------------------------
// Section and option frames
// ---------------------------------------------------------------------------

export type OptionSpec = {
  name: string;
  note: string;
  render: (run: number) => React.ReactNode;
};

/**
 * A numbered section. Options mount when the section first scrolls into
 * view, so entrances play where the owner can see them. "Replay" bumps
 * `run`: with `remount`, every option restarts from scratch; otherwise the
 * option receives the new run number and plays its own demo.
 */
export function LabSection({
  n,
  title,
  intro,
  options,
  remount = true,
  replayLabel = "Replay",
}: {
  n: number;
  title: string;
  intro: string;
  options: OptionSpec[];
  remount?: boolean;
  replayLabel?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.2 });
  const [run, setRun] = useState(0);
  const letters = "ABCD";

  return (
    <section ref={ref} id={`s${n}`} className="scroll-mt-24 border-t border-line pt-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow text-muted">Section {n}</p>
          <h2 className="mt-2 text-[24px] font-black leading-[1.15] text-ink md:text-h2">{title}</h2>
          <p className="mt-1.5 max-w-[68ch] text-base text-muted">{intro}</p>
        </div>
        <button type="button" className="btn ghost sm" onClick={() => setRun(r => r + 1)}>
          <RotateCcw className="h-4 w-4" aria-hidden />
          {replayLabel}
        </button>
      </div>

      <div
        className={clsx(
          "mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2",
          options.length === 3 && "lg:grid-cols-3",
          options.length === 4 && "xl:grid-cols-4",
        )}
      >
        {options.map((o, i) => (
          <div key={o.name} className="flex flex-col rounded-l bg-card p-5 shadow-flat">
            <div className="flex items-baseline gap-2">
              <span className="eyebrow text-accent-700">
                {n}
                {letters[i]}
              </span>
              <h3 className="text-[17px] font-black leading-tight text-ink">{o.name}</h3>
            </div>
            <p className="mt-1.5 text-sm font-medium text-muted sm:min-h-[40px]">{o.note}</p>
            <div className="mt-4 flex-1">
              {seen ? (
                <React.Fragment key={remount ? run : "stable"}>{o.render(run)}</React.Fragment>
              ) : (
                <div className="min-h-[200px] rounded-m bg-surface" />
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The quiet stage each demo sits on. */
export function Stage({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={clsx("relative rounded-m bg-surface p-4", className)}>{children}</div>;
}
