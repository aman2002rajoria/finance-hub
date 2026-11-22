"use client";

import { AiWorking, Badge, ProgressBar } from "@/components/ui";
import type { CategorizationJob } from "@/lib/api";
import { isJobRunning } from "@/lib/categorization-status";

import { jobWords, timeLeft } from "./categorization-words";

/** Inline progress for the AI product categoriser, in words (§11.6). */
export default function CategorizationProgressBanner({
  job,
  onClick,
}: {
  job: CategorizationJob;
  onClick: () => void;
}) {
  if (!isJobRunning(job)) return null;

  const pct = Math.min(100, job.progress_pct ?? 0);
  const eta = timeLeft(job);

  return (
    <section className="rounded-m bg-accent-50 px-5 py-4 shadow-[0_0_0_1px_var(--accent-100)]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <Badge tone="accent">AI</Badge>
          <AiWorking>{jobWords(job)}</AiWorking>
        </div>
        <button type="button" onClick={onClick} className="text-link text-sm">
          See details
        </button>
      </div>
      <ProgressBar
        className="mt-3"
        value={job.completed_products}
        max={Math.max(1, job.total_products)}
        label={undefined}
        format={() => `${pct}%`}
      />
      <p className="mt-2 text-[13px] font-medium tabular-nums text-muted">
        {job.completed_products.toLocaleString("en-IN")} of {job.total_products.toLocaleString("en-IN")} products
        {eta ? ` · ${eta}` : ""}
        {" · "}You can leave this page; it keeps going.
      </p>
    </section>
  );
}
