"use client";

/*
 * Health check: only the gaps. Basics that need work, each with its one-line
 * fact; basics we can't judge yet as quiet chips. What's fine is a count.
 */

import { CircleAlert, CircleDashed } from "lucide-react";
import Link from "next/link";

import { Card, CardTitle } from "@/components/ui";
import type { Check } from "@/lib/wealth";

export default function HealthCheckCard({ checks }: { checks: Check[] }) {
  const gaps = checks.filter((c) => c.ok === false);
  const unknown = checks.filter((c) => c.ok == null);
  const ok = checks.filter((c) => c.ok === true).length;

  return (
    <Card className="h-full">
      <CardTitle>{gaps.length ? `${gaps.length} ${gaps.length === 1 ? "gap" : "gaps"} in the basics` : `✅ ${ok} of ${checks.length} basics in place`}</CardTitle>
      {gaps.length > 0 && (
        <ul className="mt-3">
          {gaps.map((c) => (
            <li key={c.key} className="flex items-start gap-2.5 border-t border-line py-2.5 first:border-t-0">
              <CircleAlert aria-hidden strokeWidth={2} className="mt-0.5 h-4 w-4 shrink-0 text-warning-text" />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-extrabold text-ink">{c.label}</p>
                <p className="text-[13px] font-medium text-muted">{c.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {unknown.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {unknown.map((c) => {
            const body = (
              <>
                <CircleDashed aria-hidden strokeWidth={2} className="h-4 w-4 text-faint" />
                {c.label}
                <span className="sr-only">: not known yet. {c.detail}</span>
              </>
            );
            const cls = "inline-flex items-center gap-1.5 rounded-pill bg-surface px-3 py-1.5 text-[13px] font-semibold text-ink-2";
            return /Settings/.test(c.detail)
              ? <Link key={c.key} href="/settings" title={c.detail} className={`${cls} hover:bg-surface-2`}>{body}</Link>
              : <span key={c.key} title={c.detail} className={cls}>{body}</span>;
          })}
        </div>
      )}
      {gaps.length > 0 && ok > 0 && (
        <p className="mt-3 text-[13px] font-medium text-muted" title={checks.filter((c) => c.ok === true).map((c) => c.label).join(", ")}>
          ✅ {ok} more in place
        </p>
      )}
    </Card>
  );
}
