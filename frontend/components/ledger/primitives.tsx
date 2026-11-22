"use client";

/*
 * Building blocks shared by the ledger and tagging screens (Transactions,
 * Categorise, Rules). Everything is composed from the tokens and ui.tsx
 * vocabulary (design.md §6, §7, §11, §15); nothing here adds new colours,
 * radii or shadows.
 */

import clsx from "clsx";
import React, { useCallback, useEffect, useRef, useState } from "react";

import { Button, Chip, Modal } from "@/components/ui";
import { isTagged } from "@/lib/tagging";
import type { Transaction, TxnType } from "@/lib/types";

import { signedRupees } from "./format";

// ---------------------------------------------------------------------------
// Amount: right-aligned, tabular, credits carry a plus and success text.
// ---------------------------------------------------------------------------

export function Amount({
  amount, type, className, strong = true,
}: {
  amount: number;
  type: TxnType;
  className?: string;
  strong?: boolean;
}) {
  return (
    <span
      className={clsx(
        "whitespace-nowrap tabular-nums",
        strong ? "font-semibold" : "font-medium",
        type === "credit" ? "text-success-text" : "text-ink",
        className,
      )}
    >
      {signedRupees(amount, type)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status chips for a transaction (§3.3: tint background, text colour text).
// ---------------------------------------------------------------------------

/** True when a row still needs a category and actually counts towards spend or income. */
export function needsTag(t: Pick<Transaction, "category" | "is_internal_transfer" | "is_credit_card_payment">) {
  return !isTagged(t.category) && !t.is_internal_transfer && !t.is_credit_card_payment;
}

export function TxnStatusChips({
  t, className, size = "sm",
}: {
  t: Pick<Transaction, "category" | "is_internal_transfer" | "is_credit_card_payment" | "is_emi" | "is_refund">;
  className?: string;
  size?: "sm" | "md";
}) {
  const chips: React.ReactNode[] = [];
  if (needsTag(t)) chips.push(<Chip key="tag" size={size} tone="warning">Needs a tag</Chip>);
  if (t.is_credit_card_payment) chips.push(<Chip key="cc" size={size}>Card bill</Chip>);
  if (t.is_internal_transfer) chips.push(<Chip key="tr" size={size}>Transfer</Chip>);
  if (t.is_emi) chips.push(<Chip key="emi" size={size}>EMI</Chip>);
  if (t.is_refund) chips.push(<Chip key="rf" size={size} tone="success">Refund</Chip>);
  if (!chips.length) return null;
  return <div className={clsx("flex flex-wrap items-center gap-1.5", className)}>{chips}</div>;
}

// ---------------------------------------------------------------------------
// "Why this?" (§11.3): accent 700 link that expands a plain-words reason inline.
// ---------------------------------------------------------------------------

export function WhyThis({
  children, label = "Why this?", className,
}: {
  children: React.ReactNode;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <button
        type="button"
        className="text-link text-sm"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        {open ? "Hide why" : label}
      </button>
      {open && (
        <div className="rise-in mt-2 max-w-[62ch] text-[15px] leading-relaxed text-ink-2">{children}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suggestion block (§11.4): accent 50, eyebrow, always editable by the user.
// ---------------------------------------------------------------------------

export function SuggestionBlock({
  eyebrow = "Suggested category", title, children, aside, className,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  children?: React.ReactNode;
  aside?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("rounded-m bg-accent-50 p-5", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow text-accent-700">{eyebrow}</p>
          <p className="mt-1.5 text-h3 font-black text-ink">{title}</p>
        </div>
        {aside && <div className="flex shrink-0 flex-wrap items-center gap-2">{aside}</div>}
      </div>
      {children && <div className="mt-2 space-y-2 text-[15px] text-ink-2">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quiet section block for drawers and detail panes.
// ---------------------------------------------------------------------------

export function QuietBlock({
  title, children, className, action,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <section className={clsx("rounded-m bg-surface p-5", className)}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h3 className="text-[13px] font-semibold text-muted">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** 13/600 muted field label used in filter rows. */
export function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-semibold text-muted">
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Switch: on = accent 600 track, off = surface-2. role="switch".
// ---------------------------------------------------------------------------

export function Switch({
  checked, onChange, label, disabled, busy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      title={label}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-7 w-12 shrink-0 items-center rounded-pill transition-colors duration-300 disabled:opacity-50",
        checked ? "bg-accent-600" : "bg-surface-2",
      )}
    >
      <span
        aria-hidden
        className={clsx(
          "absolute left-1 h-5 w-5 rounded-pill bg-card shadow-flat transition-transform duration-300 ease-spring",
          checked && "translate-x-5",
        )}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Keyboard hints (§18): J/K to move, Enter to open.
// ---------------------------------------------------------------------------

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-grid min-w-[22px] place-items-center rounded-pill bg-surface-2 px-2 py-0.5 font-mono text-[12px] font-medium text-ink-2">
      {children}
    </kbd>
  );
}

export function ShortcutHint({ className, openLabel = "open" }: { className?: string; openLabel?: string }) {
  return (
    <p
      className={clsx("hidden items-center gap-1.5 text-[13px] font-medium text-muted md:flex", className)}
      title={`Keyboard: J moves down, K moves up, Enter to ${openLabel}`}
    >
      <Kbd>J</Kbd><Kbd>K</Kbd> to move <span aria-hidden>·</span> <Kbd>Enter</Kbd> to {openLabel}
    </p>
  );
}

/**
 * J/K moves focus through the items matching `selector` inside `container`.
 * Enter is left to the focused element (buttons click natively; rows handle
 * it themselves). Ignored while typing or while a dialog is open.
 */
export function useJkFocus(
  container: React.RefObject<HTMLElement>,
  selector: string,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== "j" && key !== "k") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const root = container.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(selector))
        .filter(el => el.offsetParent !== null);
      if (!items.length) return;
      const cur = items.findIndex(el => el === document.activeElement || el.contains(document.activeElement));
      let next = cur === -1 ? 0 : cur + (key === "j" ? 1 : -1);
      next = Math.max(0, Math.min(items.length - 1, next));
      e.preventDefault();
      items[next].focus();
      items[next].scrollIntoView({ block: "nearest" });
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [container, selector, enabled]);
}

// ---------------------------------------------------------------------------
// Toast (§7): bottom centre ink pill, 4s.
// ---------------------------------------------------------------------------

export function useToast() {
  const [msg, setMsg] = useState<{ id: number; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((text: string) => {
    if (timer.current) clearTimeout(timer.current);
    setMsg({ id: Date.now(), text });
    timer.current = setTimeout(() => setMsg(null), 4000);
  }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const node = msg ? (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[70] flex justify-center px-4 md:bottom-8">
      <div
        key={msg.id}
        role="status"
        aria-live="polite"
        className="toast-rise pointer-events-auto max-w-[560px] rounded-pill bg-ink px-5 py-3 text-[15px] font-medium text-card shadow-float"
      >
        {msg.text}
      </div>
      <style>{`
        .toast-rise { animation: fh-toast .45s var(--spring) both; }
        @keyframes fh-toast { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: translateY(0) } }
      `}</style>
    </div>
  ) : null;

  return { show, node };
}

// ---------------------------------------------------------------------------
// Confirm dialog (§7 Modal): destructive action on the far right.
// ---------------------------------------------------------------------------

export function ConfirmDialog({
  open, title, children, confirmLabel, tone = "primary", busy, onConfirm, onClose, note,
}: {
  open: boolean;
  title: string;
  children?: React.ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  /** Muted reassurance line under the actions. */
  note?: string;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={tone} onClick={onConfirm} loading={busy}>{confirmLabel}</Button>
          {note && <p className="w-full text-right text-sm font-medium text-muted">{note}</p>}
        </>
      }
    >
      {children && <div className="space-y-3 text-[15px] leading-relaxed text-ink-2">{children}</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Skeleton rows in the final table shape (§15).
// ---------------------------------------------------------------------------

export function TableSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="divide-y divide-line">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex h-12 items-center gap-6 px-4">
          {Array.from({ length: cols }).map((__, j) => (
            <div
              key={j}
              className={clsx("skeleton h-3.5", j === 1 ? "flex-1" : "w-20", j === cols - 1 && "ml-auto w-16")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="rounded-m p-4">
          <div className="skeleton h-4 w-2/3" />
          <div className="skeleton mt-2.5 h-3 w-1/3" />
        </div>
      ))}
    </div>
  );
}
