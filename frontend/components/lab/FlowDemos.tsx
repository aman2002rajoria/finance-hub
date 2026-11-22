"use client";

import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AiWorking, Skeleton } from "@/components/ui";

import { SOFT, Stage, spring, useReduced } from "./kit";

const SOFT_EASE = SOFT as unknown as number[];

// ---------------------------------------------------------------------------
// Shared mini content
// ---------------------------------------------------------------------------

const ROWS = [
  { name: "Swiggy", cat: "Food", amount: "₹486", date: "21 Oct" },
  { name: "Uber", cat: "Travel", amount: "₹312", date: "20 Oct" },
  { name: "Airtel postpaid", cat: "Bills", amount: "₹999", date: "18 Oct" },
];

function TxnRow({ r }: { r: (typeof ROWS)[number] }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="min-w-0">
        <span className="block truncate text-[14px] font-semibold text-ink">{r.name}</span>
        <span className="block text-[12px] font-medium text-muted">
          {r.cat} · {r.date}
        </span>
      </span>
      <span className="text-[14px] font-black tabular-nums text-ink">{r.amount}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section 7: page change inside a framed area
// ---------------------------------------------------------------------------

type Page = "Overview" | "Transactions";
export type PageKind = "none" | "fade" | "squares";

function MiniPage({ page }: { page: Page }) {
  if (page === "Overview") {
    return (
      <div className="p-3">
        <p className="text-[12px] font-semibold text-muted">Spent in October</p>
        <p className="mt-1 text-[22px] font-black leading-none tabular-nums text-accent-600">₹48,320</p>
        <div className="mt-3 flex h-[64px] items-end gap-1.5">
          {[74, 81, 69, 98, 86, 93].map((h, i) => (
            <span
              key={i}
              className={clsx("flex-1 rounded-t-[6px] rounded-b-[2px]", i === 5 ? "bg-accent-500" : "bg-surface-2")}
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="divide-y divide-line px-3 py-1">
      {ROWS.map(r => (
        <TxnRow key={r.name} r={r} />
      ))}
    </div>
  );
}

const CELL = 22;
type Wave = { phase: "cover" | "clear"; ox: number; oy: number; key: number };

export function PageChangeDemo({ kind, run }: { kind: PageKind; run: number }) {
  const reduced = useReduced();
  const frame = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<Page>("Overview");
  const [wave, setWave] = useState<Wave | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const go = (to: Page, ox?: number, oy?: number) => {
    if (to === page || wave) return;
    const el = frame.current;
    if (kind !== "squares" || reduced || !el) {
      setPage(to);
      return;
    }
    const w = el.clientWidth;
    const h = el.clientHeight;
    setSize({ w, h });
    setWave({ phase: "cover", ox: ox ?? w / 2, oy: oy ?? h / 2, key: Date.now() });
    timers.current.push(
      window.setTimeout(() => {
        setPage(to);
        setWave({ phase: "clear", ox: w / 2, oy: h / 2, key: Date.now() });
      }, 560),
      window.setTimeout(() => setWave(null), 1080),
    );
  };

  useEffect(() => {
    if (run === 0) return;
    go(page === "Overview" ? "Transactions" : "Overview");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  const onNav = (to: Page) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const f = frame.current?.getBoundingClientRect();
    go(to, f ? e.clientX - f.left : undefined, f ? e.clientY - f.top : undefined);
  };

  const squares: React.ReactNode[] = [];
  if (wave) {
    const cols = Math.ceil(size.w / CELL);
    const rows = Math.ceil(size.h / CELL);
    const far = Math.max(
      Math.hypot(wave.ox, wave.oy),
      Math.hypot(size.w - wave.ox, wave.oy),
      Math.hypot(wave.ox, size.h - wave.oy),
      Math.hypot(size.w - wave.ox, size.h - wave.oy),
    );
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = c * CELL + CELL / 2;
        const cy = r * CELL + CELL / 2;
        const t = Math.hypot(cx - wave.ox, cy - wave.oy) / far;
        const cover = wave.phase === "cover";
        squares.push(
          <motion.span
            key={`${wave.key}-${r}-${c}`}
            className="absolute rounded-[5px] bg-accent-500"
            style={{ left: c * CELL, top: r * CELL, width: CELL, height: CELL }}
            initial={{ scale: cover ? 0 : 1.2 }}
            animate={{ scale: cover ? 1.2 : 0 }}
            transition={{ duration: 0.16, ease: SOFT_EASE, delay: t * (cover ? 0.36 : 0.32) }}
          />,
        );
      }
    }
  }

  return (
    <Stage className="p-3">
      <div ref={frame} className="relative h-[210px] overflow-hidden rounded-m bg-card shadow-flat">
        <div className="flex gap-1 border-b border-line p-2">
          {(["Overview", "Transactions"] as Page[]).map(p => (
            <button
              key={p}
              type="button"
              onClick={onNav(p)}
              className={clsx(
                "rounded-pill px-3 py-1 text-[12px] font-semibold transition-colors",
                p === page ? "bg-surface-2 text-ink" : "text-muted hover:text-ink",
              )}
            >
              {p}
            </button>
          ))}
        </div>
        <div className="grid">
          {kind === "fade" || (kind === "squares" && reduced) ? (
            <AnimatePresence initial={false}>
              <motion.div
                key={page}
                className="[grid-area:1/1]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <MiniPage page={page} />
              </motion.div>
            </AnimatePresence>
          ) : (
            <MiniPage page={page} />
          )}
        </div>
        {wave && <div aria-hidden className="pointer-events-none absolute inset-0">{squares}</div>}
      </div>
      <p className="mt-2.5 text-[13px] font-medium text-muted">Click a tab inside the frame.</p>
    </Stage>
  );
}

// ---------------------------------------------------------------------------
// Section 8: loading to content
// ---------------------------------------------------------------------------

export type LoadKind = "shimmerFade" | "shimmerRise" | "ai";

const AI_WORDS = ["Reading 3 statements…", "Matching card bills…", "Sorting into categories…"];

export function LoadingDemo({ kind }: { kind: LoadKind }) {
  const reduced = useReduced();
  const [loading, setLoading] = useState(true);
  const [word, setWord] = useState(0);

  useEffect(() => {
    const total = kind === "ai" ? AI_WORDS.length * 900 : 1600;
    const t = window.setTimeout(() => setLoading(false), total);
    let w: number | undefined;
    if (kind === "ai") w = window.setInterval(() => setWord(x => Math.min(x + 1, AI_WORDS.length - 1)), 900);
    return () => {
      clearTimeout(t);
      if (w) clearInterval(w);
    };
  }, [kind]);

  const rise = kind !== "shimmerFade" && !reduced;

  return (
    <Stage>
      <div className="grid min-h-[176px] rounded-m bg-card px-4 py-2 shadow-flat">
        <AnimatePresence initial={false}>
          {loading ? (
            <motion.div
              key="loading"
              className="[grid-area:1/1]"
              exit={{ opacity: 0 }}
              transition={{ duration: kind === "shimmerFade" ? 0.3 : 0.15 }}
            >
              {kind === "ai" ? (
                <div className="flex h-full items-center">
                  <AiWorking>
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span
                        key={word}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                      >
                        {AI_WORDS[word]}
                      </motion.span>
                    </AnimatePresence>
                  </AiWorking>
                </div>
              ) : (
                <div aria-busy="true" aria-label="Loading">
                  {ROWS.map(r => (
                    <div key={r.name} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="space-y-1.5">
                        <Skeleton className="h-3.5 w-28" />
                        <Skeleton className="h-3 w-16" />
                      </span>
                      <Skeleton className="h-3.5 w-12" />
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="content"
              className="[grid-area:1/1]"
              initial="hidden"
              animate="show"
              variants={{ hidden: {}, show: { transition: { staggerChildren: rise ? 0.06 : 0 } } }}
            >
              {ROWS.map(r => (
                <motion.div
                  key={r.name}
                  variants={{
                    hidden: rise ? { opacity: 0, y: 16 } : { opacity: 0 },
                    show: { opacity: 1, y: 0, transition: { duration: rise ? 0.6 : 0.3, ease: SOFT_EASE } },
                  }}
                >
                  <TxnRow r={r} />
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Stage>
  );
}

// ---------------------------------------------------------------------------
// Section 9: success moment
// ---------------------------------------------------------------------------

export type SuccessKind = "check" | "pop" | "toast";

export function SuccessDemo({ kind }: { kind: SuccessKind }) {
  const reduced = useReduced();
  const [toast, setToast] = useState(kind === "toast");

  useEffect(() => {
    if (kind !== "toast") return;
    const t = window.setTimeout(() => setToast(false), 4000);
    return () => clearTimeout(t);
  }, [kind]);

  return (
    <Stage className="relative flex min-h-[220px] flex-col items-center justify-center overflow-hidden text-center">
      {kind === "check" && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.25 }}
          className="grid h-16 w-16 place-items-center rounded-full bg-accent-50"
        >
          <svg viewBox="0 0 24 24" className="h-8 w-8 text-accent-600" fill="none" aria-hidden>
            <motion.path
              d="M5 12.5l4.2 4.2L19 7"
              stroke="currentColor"
              strokeWidth={2.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reduced ? { opacity: 0 } : { pathLength: 0 }}
              animate={reduced ? { opacity: 1 } : { pathLength: 1 }}
              transition={{ duration: 0.5, ease: SOFT_EASE, delay: 0.2 }}
            />
          </svg>
        </motion.div>
      )}

      {kind === "pop" && (
        <motion.div
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1 }}
          transition={
            reduced
              ? { duration: 0.3 }
              : { scale: { duration: 0.6, ease: spring, delay: 0.1 }, opacity: { duration: 0.25, delay: 0.1 } }
          }
          className="grid h-24 w-24 place-items-center rounded-m border-[1.5px] border-dashed border-accent-200 bg-accent-50 p-2"
          aria-hidden
        >
          <span className="font-mono text-[10px] uppercase leading-snug tracking-[0.04em] text-accent-700">
            Statement filed
          </span>
        </motion.div>
      )}

      {kind !== "toast" && (
        <>
          <p className="mt-4 text-[17px] font-black text-ink">Statement imported</p>
          <p className="mt-1 text-[13px] font-medium text-muted">142 transactions from HDFC, October</p>
        </>
      )}

      {kind === "toast" && (
        <>
          <p className="text-[13px] font-medium text-muted">A toast appears at the bottom of the screen.</p>
          <AnimatePresence>
            {toast && (
              <motion.div
                role="status"
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
                animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.15 } }}
                transition={{ duration: 0.4, ease: SOFT_EASE, delay: 0.2 }}
                className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-m bg-card p-3 text-left shadow-float"
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-50 text-accent-600">
                  <Check className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1 text-[13px] font-medium text-ink-2">
                  <span className="font-semibold text-ink">Imported 142 transactions</span> from HDFC, October
                </span>
                <span className="text-link text-[13px]">Undo</span>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </Stage>
  );
}
