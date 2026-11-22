"use client";

import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button, Modal } from "@/components/ui";

interface Props {
  description: string;
  rawText?: string | null;
  /** Counterparty shown first, in ink, when the statement gave us one. */
  lead?: string | null;
  className?: string;
  /** When set, clicking opens the full transaction instead of the text-only view. */
  onOpenDetails?: () => void;
}

/**
 * One-line description for ledger rows: counterparty in ink, statement text
 * muted. Hover (or focus) shows the full text in a popover; click opens the
 * transaction, or a text-only view when there's nothing else to open.
 */
export function TransactionDescriptionCell({
  description,
  rawText,
  lead,
  className,
  onOpenDetails,
}: Props) {
  const [modalOpen, setModalOpen] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, above: false });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasRaw = Boolean(rawText && rawText !== description);
  const showLead = Boolean(lead && lead.trim() && !description.toLowerCase().startsWith(lead.toLowerCase()));

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const maxW = Math.min(320, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - maxW - 8));
    const above = window.innerHeight - r.bottom < 180;
    setPos({ top: above ? r.top - 8 : r.bottom + 8, left, above });
  }, []);

  function clearHide() {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }
  function show() {
    clearHide();
    updatePosition();
    setHoverOpen(true);
  }
  function scheduleHide() {
    clearHide();
    hideTimer.current = setTimeout(() => setHoverOpen(false), 120);
  }

  useEffect(() => {
    if (!hoverOpen) return;
    const onMove = () => updatePosition();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [hoverOpen, updatePosition]);

  useEffect(() => () => clearHide(), []);

  const popover = hoverOpen && typeof document !== "undefined" ? createPortal(
    <div
      role="tooltip"
      className={clsx(
        "desc-pop pointer-events-auto fixed z-[100] max-h-72 w-[min(320px,calc(100vw-16px))] overflow-y-auto rounded-[16px] bg-card px-4 py-3.5 shadow-float",
        pos.above && "-translate-y-full",
      )}
      style={{ top: pos.top, left: pos.left }}
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      {lead && <p className="text-sm font-extrabold text-ink">{lead}</p>}
      <p className={clsx("whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink-2", lead && "mt-1")}>
        {description}
      </p>
      {hasRaw && (
        <p className="mt-2.5 whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-muted">
          {rawText}
        </p>
      )}
      <style>{`
        .desc-pop { animation: fh-desc .3s var(--soft) both; }
        @keyframes fh-desc { from { opacity: 0 } to { opacity: 1 } }
      `}</style>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
        onFocus={show}
        onBlur={scheduleHide}
        onClick={e => {
          e.stopPropagation();
          setHoverOpen(false);
          if (onOpenDetails) onOpenDetails();
          else setModalOpen(true);
        }}
        className={clsx(
          "flex w-full min-w-0 items-baseline gap-2 rounded-s text-left text-[15px] leading-snug",
          className,
        )}
        aria-label={`${lead ? `${lead}: ` : ""}${description}`}
      >
        {showLead && <span className="max-w-[55%] shrink-0 truncate font-semibold text-ink">{lead}</span>}
        <span className={clsx("min-w-0 truncate", showLead ? "text-sm text-muted" : "font-medium text-ink")}>
          {description}
        </span>
      </button>

      {popover}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Statement text"
        width="max-w-[640px]"
        footer={<Button variant="ghost" onClick={() => setModalOpen(false)}>Close</Button>}
      >
        <div className="space-y-4">
          {lead && <p className="text-h3 font-black text-ink">{lead}</p>}
          <div>
            <p className="mb-1.5 text-[13px] font-semibold text-muted">Description</p>
            <p className="whitespace-pre-wrap break-words rounded-s bg-surface p-4 text-[15px] leading-relaxed text-ink-2">
              {description}
            </p>
          </div>
          {hasRaw && (
            <div>
              <p className="mb-1.5 text-[13px] font-semibold text-muted">As printed on the statement</p>
              <p className="whitespace-pre-wrap break-words rounded-s bg-surface p-4 font-mono text-[12px] leading-relaxed text-ink-2">
                {rawText}
              </p>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
