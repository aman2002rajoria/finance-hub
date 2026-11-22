"use client";

import clsx from "clsx";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

import styles from "./lab.module.css";
import { SOFT, Stage, spring, useReduced } from "./kit";

const SOFT_EASE = SOFT as unknown as number[];

// ---------------------------------------------------------------------------
// Section 5: tabs / segmented control
// ---------------------------------------------------------------------------

const TABS = ["Food", "Travel", "Bills"] as const;
type Tab = (typeof TABS)[number];

const MERCHANTS: Record<Tab, { name: string; amount: string; note: string }[]> = {
  Food: [
    { name: "Swiggy", amount: "₹4,820", note: "14 orders" },
    { name: "Zomato", amount: "₹3,140", note: "9 orders" },
    { name: "BigBasket", amount: "₹2,960", note: "3 orders" },
  ],
  Travel: [
    { name: "IndiGo", amount: "₹4,450", note: "BLR to DEL" },
    { name: "Uber", amount: "₹3,210", note: "18 rides" },
    { name: "Namma Metro", amount: "₹1,240", note: "Card top-ups" },
  ],
  Bills: [
    { name: "BESCOM", amount: "₹2,340", note: "Electricity" },
    { name: "ACT Fibernet", amount: "₹1,180", note: "Broadband" },
    { name: "Airtel", amount: "₹999", note: "Postpaid" },
  ],
};

export type TabKind = "slide" | "crossfade" | "directional";

function MerchantList({ tab }: { tab: Tab }) {
  return (
    <ul className="divide-y divide-line">
      {MERCHANTS[tab].map(m => (
        <li key={m.name} className="flex items-center justify-between gap-3 py-2.5">
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-semibold text-ink">{m.name}</span>
            <span className="block text-[12px] font-medium text-muted">{m.note}</span>
          </span>
          <span className="text-[14px] font-black tabular-nums text-ink">{m.amount}</span>
        </li>
      ))}
    </ul>
  );
}

export function TabsDemo({ kind, id, run }: { kind: TabKind; id: string; run: number }) {
  const reduced = useReduced();
  const [tab, setTab] = useState<Tab>("Food");
  const [dir, setDir] = useState(1);

  const choose = (t: Tab) => {
    setDir(TABS.indexOf(t) >= TABS.indexOf(tab) ? 1 : -1);
    setTab(t);
  };

  useEffect(() => {
    if (run === 0) return;
    setTab(prev => {
      const next = TABS[(TABS.indexOf(prev) + 1) % TABS.length];
      setDir(TABS.indexOf(next) > TABS.indexOf(prev) ? 1 : -1);
      return next;
    });
  }, [run]);

  const slides = kind !== "crossfade" && !reduced;

  return (
    <Stage>
      <LayoutGroup id={`tabs-${id}`}>
        <div role="tablist" aria-label="Category" className="inline-flex gap-1 rounded-pill bg-card p-1 shadow-flat">
          {TABS.map(t => {
            const active = t === tab;
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => choose(t)}
                className={clsx(
                  "relative rounded-pill px-3.5 py-1.5 text-[13px] font-semibold transition-colors duration-200",
                  active ? "text-ink" : "text-muted hover:text-ink",
                )}
              >
                {active &&
                  (slides ? (
                    <motion.span
                      layoutId="pill"
                      className="absolute inset-0 rounded-pill bg-surface-2"
                      transition={{ duration: 0.35, ease: spring }}
                    />
                  ) : (
                    <span className="absolute inset-0 rounded-pill bg-surface-2" />
                  ))}
                <span className="relative">{t}</span>
              </button>
            );
          })}
        </div>
      </LayoutGroup>

      <div className="mt-3 grid overflow-hidden rounded-m bg-card px-4 py-1 shadow-flat">
        {kind === "slide" ? (
          <MerchantList tab={tab} />
        ) : (
          <AnimatePresence initial={false} custom={dir}>
            <motion.div
              key={tab}
              className="[grid-area:1/1]"
              custom={dir}
              variants={{
                enter: (d: number) =>
                  kind === "directional" && !reduced ? { opacity: 0, x: d * 40 } : { opacity: 0 },
                center: { opacity: 1, x: 0 },
                exit: (d: number) =>
                  kind === "directional" && !reduced ? { opacity: 0, x: d * -40 } : { opacity: 0 },
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={
                kind === "directional" && !reduced
                  ? { x: { duration: 0.35, ease: spring }, opacity: { duration: 0.2 } }
                  : { duration: 0.2, ease: SOFT_EASE }
              }
            >
              <MerchantList tab={tab} />
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </Stage>
  );
}

// ---------------------------------------------------------------------------
// Section 6: buttons
// ---------------------------------------------------------------------------

export type ButtonKind = "lip" | "ripple" | "glow";

type Ripple = { id: number; x: number; y: number; size: number };

function LabButton({
  kind,
  variant,
  children,
}: {
  kind: ButtonKind;
  variant: "primary" | "dark" | "ghost";
  children: React.ReactNode;
}) {
  const reduced = useReduced();
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const nextId = useRef(0);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (kind !== "ripple") return;
    const r = e.currentTarget.getBoundingClientRect();
    const size = Math.hypot(r.width, r.height) * 2;
    setRipples(list => [...list, { id: nextId.current++, x: e.clientX - r.left, y: e.clientY - r.top, size }]);
  };

  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      className={clsx(
        "btn sm relative",
        variant === "primary" && "primary",
        variant === "ghost" && "ghost",
        kind === "glow" && styles.glow,
      )}
    >
      {kind === "ripple" && (
        <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-pill">
          {ripples.map(rp => (
            <motion.span
              key={rp.id}
              className="absolute rounded-full"
              style={{
                left: rp.x - rp.size / 2,
                top: rp.y - rp.size / 2,
                width: rp.size,
                height: rp.size,
                background: "color-mix(in srgb, currentColor 22%, transparent)",
              }}
              initial={reduced ? { opacity: 1, scale: 1 } : { opacity: 1, scale: 0 }}
              animate={{ opacity: 0, scale: 1 }}
              transition={{ duration: reduced ? 0.4 : 0.6, ease: SOFT_EASE }}
              onAnimationComplete={() => setRipples(list => list.filter(x => x.id !== rp.id))}
            />
          ))}
        </span>
      )}
      <span className="relative">{children}</span>
    </button>
  );
}

export function ButtonsDemo({ kind }: { kind: ButtonKind }) {
  return (
    <Stage className="flex min-h-[200px] flex-col items-start justify-center gap-3">
      <LabButton kind={kind} variant="primary">Upload statements</LabButton>
      <div className="flex flex-wrap gap-3">
        <LabButton kind={kind} variant="dark">Approve</LabButton>
        <LabButton kind={kind} variant="ghost">Skip</LabButton>
      </div>
      <p className="text-[13px] font-medium text-muted">Hover, then press and hold.</p>
    </Stage>
  );
}
