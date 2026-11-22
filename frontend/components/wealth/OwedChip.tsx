"use client";

/*
 * "💳 ₹10k owed" in the Wealth header. Tap it for the list: card bills come
 * from the statements (read only); loans you added can be edited.
 */

import clsx from "clsx";
import { ChevronDown, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { inr } from "@/lib/format";
import type { Liability } from "@/lib/wealth";

import { shortInr } from "./chartKit";

const fromStatements = (l: Liability) => l.id.startsWith("card-");

export default function OwedChip({
  liabilities, onAdd, onEdit,
}: {
  liabilities: Liability[];
  onAdd: () => void;
  onEdit: (l: Liability) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const owe = liabilities.reduce((s, l) => s + l.outstanding, 0);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key); };
  }, [open]);

  return (
    <span ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-pill bg-card px-2.5 py-1 font-medium text-ink-2 shadow-flat transition-colors hover:bg-surface focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-accent-500"
      >
        <span aria-hidden>💳</span>
        <span className="tabular-nums font-semibold text-ink">{owe > 0 ? shortInr(owe) : "₹0"}</span> owed
        <ChevronDown aria-hidden strokeWidth={2} className={clsx("h-3.5 w-3.5 text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div role="dialog" aria-label="What you owe" className="absolute left-0 top-[calc(100%+8px)] z-40 w-[280px] max-w-[calc(100vw-32px)] rounded-m bg-card p-3 shadow-float">
          {liabilities.length ? (
            <ul className="space-y-0.5">
              {liabilities.map((l) => {
                const ro = fromStatements(l);
                const body = (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-semibold text-ink">{l.name}</span>
                      <span className="block text-[12px] font-medium text-muted">
                        {ro ? "Unpaid, from statements" : l.emi ? `${inr(l.emi)} a month` : "Added by you"}
                      </span>
                    </span>
                    <span className="shrink-0 text-[14px] font-extrabold tabular-nums text-ink">−{inr(l.outstanding)}</span>
                  </>
                );
                return (
                  <li key={l.id}>
                    {ro ? (
                      <div className="flex items-center gap-3 px-2 py-1.5">{body}</div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setOpen(false); onEdit(l); }}
                        className="flex w-full items-center gap-3 rounded-s px-2 py-1.5 text-left hover:bg-surface"
                      >
                        {body}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-2 py-1.5 text-[14px] font-medium text-muted">Nothing owed.</p>
          )}
          <button
            type="button"
            onClick={() => { setOpen(false); onAdd(); }}
            className="mt-1 inline-flex items-center gap-1 rounded-pill px-2 py-1 text-[13px] font-semibold text-accent-700 hover:bg-surface"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />Add a loan
          </button>
        </div>
      )}
    </span>
  );
}
