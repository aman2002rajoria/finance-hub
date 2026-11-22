"use client";

/*
 * Shared loading / empty / error handling for Overview cards (design.md §15).
 * Every card renders a skeleton in its final shape, an EmptyState with an
 * illustration slot, or an ErrorCard with "Try again" wired to SWR's mutate.
 */

import clsx from "clsx";
import type React from "react";

import { Card, CardTitle, EmptyState, ErrorCard, Skeleton } from "@/components/ui";

/** Plain-words error copy: what happened + what to do. Never a raw code alone. */
export function errorMessage(err: unknown, what = "this"): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (/fetch|network|Failed to/i.test(raw) || /^5\d\d/.test(raw)) {
    return `We couldn't load ${what} because the Finance Hub server didn't answer. Check it's running, then try again.`;
  }
  return `We couldn't load ${what}. Try again, and if it keeps failing, reload the page.`;
}

/** A titled card that swaps its body for skeleton / error / empty states. */
export function StatefulCard({
  title,
  subtitle,
  action,
  className,
  loading,
  error,
  onRetry,
  empty,
  emptyTitle,
  emptyHint,
  emptyIllustration = "stack of statements",
  emptyAction,
  skeleton,
  what,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  loading: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  emptyIllustration?: string;
  emptyAction?: React.ReactNode;
  /** Skeleton in the final shape of the card body. */
  skeleton?: React.ReactNode;
  /** Noun for the error sentence, e.g. "your categories". */
  what?: string;
  children?: React.ReactNode;
}) {
  if (error && !loading) {
    return (
      <ErrorCard
        className={clsx("h-full", className)}
        title={`${title} didn't load`}
        message={errorMessage(error, what ?? title.toLowerCase())}
        onRetry={onRetry}
      />
    );
  }

  return (
    <Card className={clsx("h-full", className)}>
      <CardTitle subtitle={subtitle} action={loading ? undefined : action}>
        {title}
      </CardTitle>
      <div className="mt-5">
        {loading ? (
          <div aria-busy="true" aria-label={`Loading ${title.toLowerCase()}`}>
            {skeleton ?? <Skeleton className="h-48 w-full" />}
          </div>
        ) : empty ? (
          <EmptyState
            compact
            illustration={emptyIllustration}
            title={emptyTitle ?? "Nothing here yet"}
            hint={emptyHint}
            action={emptyAction}
          />
        ) : (
          children
        )}
      </div>
    </Card>
  );
}

/** Skeleton list rows: label on the left, number on the right. */
export function RowsSkeleton({ rows = 5, withDot = false }: { rows?: number; withDot?: boolean }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          {withDot && <Skeleton className="h-3 w-3 !rounded-full" />}
          <Skeleton className="h-4" style={{ width: `${55 - i * 5}%` }} />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Skeleton bar chart: rounded bars of varying height. */
export function BarsSkeleton({ bars = 6, height = 220 }: { bars?: number; height?: number }) {
  return (
    <div className="flex items-end gap-3" style={{ height }}>
      {Array.from({ length: bars }).map((_, i) => (
        <Skeleton
          key={i}
          className="flex-1 !rounded-s"
          style={{ height: `${45 + ((i * 37) % 50)}%` }}
        />
      ))}
    </div>
  );
}
