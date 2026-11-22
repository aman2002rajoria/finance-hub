"use client";

/*
 * Finance Hub component vocabulary (design.md §6, §7, §15).
 *
 * Every page composes from these. Existing exports keep their old props so
 * older pages compile; new screens should prefer KpiCard, InsightCard,
 * Segmented, Badge, Skeleton, ErrorCard and AiWorking.
 */

import clsx from "clsx";
import React from "react";
import { createPortal } from "react-dom";

import { MotionReveal } from "@/components/motion/MotionReveal";
import { NumberTicker } from "@/components/motion/NumberTicker";
import { metricFormatHints, parseMetricNumber } from "@/lib/motion";

// ---------------------------------------------------------------------------
// Card: white, 28px radius, hairline ring, 24px padding.
// ---------------------------------------------------------------------------

export function Card({
  children,
  className,
  padded = true,
  nested = false,
  motion = false,
  motionIndex = 0,
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
  /** A quiet `--surface` block inside another card. */
  nested?: boolean;
  /** Fade-and-rise on first view (§14). */
  motion?: boolean;
  motionIndex?: number;
  /** Ignored: cards never lift on hover (§20). Kept for old call sites. */
  hoverLift?: boolean;
}) {
  const inner = (
    <div
      className={clsx(
        nested ? "rounded-m bg-surface" : "rounded-l bg-card shadow-flat",
        padded && (nested ? "p-4 md:p-5" : "p-5 md:p-6"),
        className,
      )}
    >
      {children}
    </div>
  );

  if (motion) {
    return (
      <MotionReveal index={motionIndex} className="h-full">
        {inner}
      </MotionReveal>
    );
  }
  return inner;
}

/** Card title: H3 900, with an optional muted sub-line and right-side slot. */
export function CardTitle({
  children,
  className,
  subtitle,
  action,
}: {
  children: React.ReactNode;
  className?: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={clsx("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h3 className="text-h3 font-black text-ink">{children}</h3>
        {subtitle && <p className="mt-1 text-sm font-medium text-muted">{subtitle}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page header: eyebrow, H1 900, Body L intro, actions on the right.
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
  meta,
  eyebrow,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-x-6">
      <div className="min-w-0 flex-1">
        {eyebrow && <p className="eyebrow mb-3 text-muted">{eyebrow}</p>}
        <h1 className="text-[32px] font-black leading-[1.08] tracking-[-0.01em] text-ink md:text-h1">
          {title}
        </h1>
        {description && (
          <p className="mt-3 max-w-[68ch] text-base text-ink-2 md:text-body-l">{description}</p>
        )}
        {meta && <div className="mt-4 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div>
      )}
    </header>
  );
}

export function SectionHeading({
  title,
  subtitle,
  className,
  action,
}: {
  title: string;
  subtitle?: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className={clsx("flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="text-[24px] font-black leading-[1.15] text-ink md:text-h2">{title}</h2>
        {subtitle && <p className="mt-1.5 max-w-[68ch] text-base text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={clsx("eyebrow text-muted", className)}>{children}</p>;
}

// ---------------------------------------------------------------------------
// Button: the 3D lip (§6). One `primary` per view.
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "dark" | "ghost" | "danger" | "outline";

export function Button({
  variant = "secondary",
  size = "md",
  className,
  loading = false,
  children,
  disabled,
  type = "button",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** primary = accent; secondary/dark = ink; ghost/outline = white; danger = confirm-only. */
  variant?: ButtonVariant;
  /** sm = dense rows, md = most actions, lg = the screen's main action. */
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}) {
  const variants: Record<ButtonVariant, string> = {
    primary: "primary",
    secondary: "",
    dark: "",
    ghost: "ghost",
    outline: "ghost",
    danger: "danger",
  };
  const sizes = { sm: "xs", md: "sm", lg: "" };
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx("btn", variants[variant], sizes[size], className)}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

/** 40px circular ghost icon button. Always pass an aria-label. */
export function IconButton({
  className,
  children,
  size = "md",
  type = "button",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: "sm" | "md"; "aria-label": string }) {
  return (
    <button
      {...rest}
      type={type}
      className={clsx("btn ghost icon", size === "sm" && "sm", className)}
    >
      {children}
    </button>
  );
}

/** Tiny inline spinner for buttons only. For waits over a second use AiWorking or Skeleton. */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={clsx("animate-spin", className)} aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Segmented control (§7): surface track, white active pill.
// ---------------------------------------------------------------------------

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  size = "md",
  ariaLabel,
}: {
  options: { value: T; label: React.ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  size?: "sm" | "md";
  ariaLabel?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={clsx("inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-pill bg-surface p-1", className)}
    >
      {options.map(o => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={clsx(
              "shrink-0 rounded-pill font-semibold transition-[background,color,box-shadow,transform] duration-300 active:scale-[.94]",
              size === "sm" ? "px-3 py-1.5 text-[13px]" : "px-4 py-2 text-sm",
              active
                ? "bg-card text-ink shadow-[0_0_0_1px_var(--line),0_1px_0_var(--surface-2)]"
                : "text-muted hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter pill: a clickable chip that can be on or off.
// ---------------------------------------------------------------------------

export function FilterPill({
  label,
  active,
  onClick,
  icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-sm font-medium transition-colors duration-200 active:scale-[.96]",
        active
          ? "bg-ink text-card"
          : "bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Chip and Badge (§7). Status chips use tint backgrounds, never fills.
// ---------------------------------------------------------------------------

type ChipTone =
  | "neutral" | "accent" | "success" | "warning" | "danger"
  // legacy tone names
  | "blue" | "green" | "amber" | "red" | "violet";

const CHIP_TONES: Record<ChipTone, string> = {
  neutral: "bg-surface text-ink-2",
  accent: "bg-accent-50 text-accent-700",
  success: "bg-success-tint text-success-text",
  warning: "bg-warning-tint text-warning-text",
  danger: "bg-danger-tint text-danger-text",
  blue: "bg-surface text-ink-2",
  violet: "bg-surface text-ink-2",
  green: "bg-accent-50 text-accent-700",
  amber: "bg-warning-tint text-warning-text",
  red: "bg-danger-tint text-danger-text",
};

export function Chip({
  children,
  tone = "neutral",
  className,
  size = "md",
  title,
}: {
  children: React.ReactNode;
  tone?: ChipTone;
  className?: string;
  size?: "sm" | "md";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-pill font-medium",
        size === "sm" ? "px-2.5 py-0.5 text-[13px]" : "px-3 py-1 text-sm",
        CHIP_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent" | "warning" | "success" | "danger";
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-pill px-2 py-[3px] text-badge font-extrabold uppercase",
        CHIP_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Form primitives (§7): surface fill, no border, accent ring + halo on focus.
// ---------------------------------------------------------------------------

const FIELD =
  "w-full rounded-pill bg-surface px-5 text-base text-ink placeholder:text-faint " +
  "transition-[background,box-shadow] duration-200 " +
  "focus:bg-card focus:outline-none focus:shadow-[0_0_0_2px_var(--accent-500),0_0_0_6px_var(--accent-100)] " +
  "disabled:opacity-50";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input(props, ref) {
    return <input ref={ref} {...props} className={clsx(FIELD, "h-12", props.className)} />;
  },
);

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={clsx(
        FIELD,
        "h-12 cursor-pointer appearance-none bg-[length:16px] bg-[right_16px_center] bg-no-repeat pr-11",
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2376767E' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")]",
        props.className,
      )}
    />
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={clsx(
        "w-full rounded-m bg-surface p-5 text-base text-ink placeholder:text-faint",
        "transition-[background,box-shadow] duration-200",
        "focus:bg-card focus:outline-none focus:shadow-[0_0_0_2px_var(--accent-500),0_0_0_6px_var(--accent-100)]",
        props.className,
      )}
    />
  );
}

export function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-2 block text-[13px] font-semibold text-ink-2">
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Modal (§7): 520px max, 28px radius, lifted shadow, blurred 40% backdrop.
// ---------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = "max-w-[520px]",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  // Portal to <body> so the backdrop covers the sticky top bar too.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-backdrop absolute inset-0 bg-black/40 backdrop-blur-[4px]" onClick={onClose} />
      <div
        className={clsx(
          "modal-panel relative flex max-h-[90vh] w-full flex-col rounded-l bg-card shadow-lift",
          width,
        )}
      >
        <div className="flex items-start justify-between gap-4 px-7 pb-2 pt-7">
          <h2 className="text-[24px] font-black leading-[1.15] text-ink">{title}</h2>
          <IconButton size="sm" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </IconButton>
        </div>
        <div className="overflow-y-auto px-7 py-4">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-3 px-7 pb-6 pt-3">{footer}</div>
        )}
      </div>
      <style>{`
        .modal-backdrop { animation: fh-fade .2s var(--soft) both; }
        .modal-panel { animation: fh-pop .45s var(--spring) both; }
        @keyframes fh-fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes fh-pop { from { opacity: 0; transform: scale(.96) } to { opacity: 1; transform: scale(1) } }
      `}</style>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Table (§7): muted 13/600 header, 44–48px rows, hairline, surface hover.
// ---------------------------------------------------------------------------

export function DataTable({
  children,
  className,
  compact = false,
}: {
  children: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={clsx("overflow-x-auto", className)}>
      <table className={clsx("min-w-full", compact ? "text-sm" : "text-[15px]")}>{children}</table>
    </div>
  );
}

export function TableHead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="sticky top-0 z-10 border-b border-line bg-card text-[13px] font-semibold text-muted">
      {children}
    </thead>
  );
}

export function TableHeadCell({
  children,
  className,
  align = "left",
  onClick,
  compact = false,
}: {
  children?: React.ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
  onClick?: () => void;
  compact?: boolean;
}) {
  return (
    <th
      onClick={onClick}
      className={clsx(
        compact ? "px-3 py-3" : "px-4 py-3",
        "whitespace-nowrap font-semibold transition-colors",
        onClick && "cursor-pointer select-none hover:text-ink",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TableRow({
  children,
  className,
  onClick,
}: {
  children: React.ReactNode;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLTableRowElement>;
}) {
  return (
    <tr
      onClick={onClick}
      className={clsx(
        "row-hover border-b border-line transition-colors duration-150 last:border-b-0",
        onClick && "cursor-pointer",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function TableCell({
  children,
  className,
  align = "left",
  title,
  compact = false,
}: {
  children?: React.ReactNode;
  className?: string;
  align?: "left" | "right" | "center";
  title?: string;
  compact?: boolean;
}) {
  return (
    <td
      title={title}
      className={clsx(
        compact ? "px-3 py-2.5" : "px-4 py-3",
        "text-ink",
        align === "right" && "text-right tabular-nums",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </td>
  );
}

// ---------------------------------------------------------------------------
// Banners and states (§15)
// ---------------------------------------------------------------------------

export function AlertBanner({
  children,
  variant = "info",
  onDismiss,
}: {
  children: React.ReactNode;
  variant?: "info" | "success" | "warning" | "danger" | "highlight";
  onDismiss?: () => void;
}) {
  const styles = {
    info: "bg-surface text-ink-2",
    success: "bg-success-tint text-success-text",
    warning: "bg-warning-tint text-warning-text",
    danger: "bg-danger-tint text-danger-text",
    highlight: "bg-accent-50 text-accent-900",
  };
  return (
    <div role="status" className={clsx("flex items-start gap-3 rounded-m px-5 py-4 text-[15px] font-medium", styles[variant])}>
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="-mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-full opacity-70 transition hover:bg-black/5 hover:opacity-100"
          aria-label="Dismiss"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      )}
    </div>
  );
}

/** Error state: what went wrong, what to do, and Try again (§15). */
export function ErrorCard({
  title = "That didn't load",
  message,
  onRetry,
  className,
}: {
  title?: string;
  message: React.ReactNode;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={clsx("rounded-l bg-danger-tint p-6", className)}>
      <p className="text-h3 font-black text-danger-text">{title}</p>
      <p className="mt-1.5 max-w-[68ch] text-[15px] text-ink-2">{message}</p>
      {onRetry && (
        <Button variant="ghost" size="md" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/**
 * Empty state (§15): centred illustration slot, H3, one muted sentence,
 * one action. Until the 3D renders exist, the illustration is a dashed box
 * naming the object (§13).
 */
export function EmptyState({
  title,
  hint,
  icon,
  action,
  compact = false,
  illustration,
}: {
  title: string;
  hint?: string;
  /** Legacy: small icon above the title. Prefer `illustration`. */
  icon?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
  /** Object name for the illustration placeholder, e.g. "stack of statements". */
  illustration?: string;
  /** Ignored: no ambient effects (§20). */
  ambient?: boolean;
}) {
  return (
    <div
      className={clsx(
        "flex flex-col items-center justify-center text-center",
        compact ? "px-6 py-10" : "px-6 py-16",
      )}
    >
      {illustration ? (
        <IllustrationSlot label={illustration} size={compact ? 96 : 128} className="mb-5" />
      ) : icon ? (
        <div className="mb-4 grid h-14 w-14 place-items-center rounded-full bg-surface text-muted">{icon}</div>
      ) : null}
      <p className="text-h3 font-black text-ink">{title}</p>
      {hint && <p className="mt-2 max-w-md text-base text-muted">{hint}</p>}
      {action && <div className="mt-6 flex flex-wrap items-center justify-center gap-3">{action}</div>}
    </div>
  );
}

/** Dashed placeholder for a glossy 3D render that doesn't exist yet (§13). */
export function IllustrationSlot({
  label,
  size = 128,
  className,
}: {
  label: string;
  size?: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      style={{ width: size, height: size }}
      className={clsx(
        "illustration-pop grid place-items-center rounded-m border-[1.5px] border-dashed border-accent-200 bg-accent-50 p-3",
        className,
      )}
    >
      <span className="text-center font-mono text-[11px] uppercase leading-snug tracking-[0.04em] text-accent-700">
        {label}
      </span>
      <style>{`
        .illustration-pop { animation: fh-ill-pop .6s var(--spring) both; }
        @keyframes fh-ill-pop { from { opacity: 0; transform: scale(.9) } to { opacity: 1; transform: scale(1) } }
      `}</style>
    </div>
  );
}

/** Skeleton block in the final shape (§15). */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden className={clsx("skeleton", className)} style={style} />;
}

/** Card-shaped loading skeleton with a title bar and body. */
export function CardSkeleton({ height = 260, className }: { height?: number; className?: string }) {
  return (
    <div className={clsx("rounded-l bg-card p-6 shadow-flat", className)} aria-busy="true" aria-label="Loading">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="mt-5 w-full" style={{ height: height - 80 }} />
    </div>
  );
}

/** Work in progress, in words, with three pulsing dots (§11.6). */
export function AiWorking({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={clsx("flex items-center gap-3 text-[15px] font-medium text-ink-2", className)}>
      <span className="ai-dots" aria-hidden><span /><span /><span /></span>
      <span>{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI card (§7): muted label, 900 tabular number, sub-line that explains it.
// ---------------------------------------------------------------------------

export function KpiCard({
  label,
  value,
  sub,
  focus = false,
  tone,
  onClick,
  animate = true,
  motionIndex = 0,
  loading = false,
}: {
  label: string;
  value: string | number;
  /** Explains the number: what's included or left out. */
  sub?: React.ReactNode;
  /** The single most important number on the screen: shown in accent. */
  focus?: boolean;
  tone?: "warning" | "danger" | "success";
  onClick?: () => void;
  animate?: boolean;
  motionIndex?: number;
  loading?: boolean;
}) {
  const valueTone =
    focus ? "text-accent-600" :
    tone === "warning" ? "text-warning-text" :
    tone === "danger" ? "text-danger-text" :
    tone === "success" ? "text-success-text" :
    "text-ink";

  const numeric = parseMetricNumber(value);
  const { prefix, suffix, decimals } = metricFormatHints(value);
  const valueClass = clsx("text-[28px] font-black leading-none tracking-[-0.01em] tabular-nums md:text-number", valueTone);

  const valueNode = loading ? (
    <Skeleton className="h-8 w-32" />
  ) : animate && numeric != null ? (
    <NumberTicker value={numeric} prefix={prefix} suffix={suffix} decimalPlaces={decimals} className={valueClass} />
  ) : (
    <span className={valueClass}>
      {typeof value === "number" ? value.toLocaleString("en-IN") : value}
    </span>
  );

  const Tag = onClick ? "button" : "div";

  return (
    <MotionReveal index={motionIndex} className="h-full">
      <Tag
        type={onClick ? "button" : undefined}
        onClick={onClick}
        className={clsx(
          "flex h-full w-full flex-col rounded-m bg-card p-5 text-left shadow-flat",
          onClick && "cursor-pointer transition-colors hover:bg-surface",
        )}
      >
        <span className="text-sm font-semibold text-muted">{label}</span>
        <span className="mt-3 block">{valueNode}</span>
        {sub && <span className="mt-3 block text-sm font-medium text-muted">{sub}</span>}
      </Tag>
    </MotionReveal>
  );
}

/** Legacy KPI tile: now a KpiCard. `hint` becomes the sub-line. */
export function MetricTile({
  label,
  value,
  hint,
  tone,
  onClick,
  animate = true,
  motionIndex = 0,
  focus,
}: {
  label: string;
  value: string | number;
  hint?: string;
  /** Legacy: icons are dropped from KPI cards. */
  icon?: React.ReactNode;
  tone?: "green" | "amber" | "red";
  onClick?: () => void;
  animate?: boolean;
  motionIndex?: number;
  focus?: boolean;
}) {
  return (
    <KpiCard
      label={label}
      value={value}
      sub={hint}
      focus={focus ?? tone === "green"}
      tone={tone === "amber" ? "warning" : tone === "red" ? "danger" : undefined}
      onClick={onClick}
      animate={animate}
      motionIndex={motionIndex}
    />
  );
}

// ---------------------------------------------------------------------------
// Insight card (§7): one per screen, accent 50 tint, the insight as a sentence.
// ---------------------------------------------------------------------------

export function InsightCard({
  title,
  eyebrow,
  children,
  className,
  action,
}: {
  title: string;
  eyebrow?: string;
  children?: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <section className={clsx("rounded-l bg-accent-50 p-6 shadow-[0_0_0_1px_var(--accent-100)]", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && <p className="eyebrow mb-2 text-accent-700">{eyebrow}</p>}
          <h3 className="text-h3 font-black text-ink">{title}</h3>
        </div>
        {action}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Progress / score bar (§7)
// ---------------------------------------------------------------------------

export function ProgressBar({
  value,
  max = 100,
  label,
  showValue = true,
  format,
  className,
  tone = "accent",
}: {
  value: number;
  max?: number;
  label?: string;
  showValue?: boolean;
  format?: (v: number) => string;
  className?: string;
  tone?: "accent" | "warning" | "danger" | "muted";
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const fill =
    tone === "warning" ? "bg-warning" :
    tone === "danger" ? "bg-danger" :
    tone === "muted" ? "bg-faint" : "bg-accent-500";
  return (
    <div className={clsx("flex items-center gap-3", className)}>
      {label && <span className="w-24 shrink-0 text-sm font-semibold text-ink-2">{label}</span>}
      <div className="h-2.5 flex-1 overflow-hidden rounded-[10px] bg-surface-2" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="fh-bar-grow h-full rounded-[10px]" style={{ width: `${pct}%` }}>
          <div className={clsx("h-full w-full rounded-[10px]", fill)} />
        </div>
      </div>
      {showValue && (
        <span className="w-12 shrink-0 text-right text-sm font-semibold tabular-nums text-ink-2">
          {format ? format(value) : `${Math.round(pct)}%`}
        </span>
      )}
      <style>{`
        .fh-bar-grow { transform-origin: left; animation: fh-bar 1s var(--spring) .2s both; }
        @keyframes fh-bar { from { transform: scaleX(0) } to { transform: scaleX(1) } }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

export function PageSection({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={clsx("space-y-8 md:space-y-10", className)}>{children}</div>;
}
