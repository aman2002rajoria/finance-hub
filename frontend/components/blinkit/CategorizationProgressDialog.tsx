"use client";

import { useEffect, useRef, useState } from "react";

import {
  AiWorking, Badge, Button, Chip, Modal, ProgressBar,
} from "@/components/ui";
import type { CategorizationJob } from "@/lib/api";
import { fmtDuration, isJobRunning } from "@/lib/categorization-status";

import { jobWords, timeLeft } from "./categorization-words";

const n = (v: number) => v.toLocaleString("en-IN");

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-s bg-surface px-4 py-3">
      <p className="text-[13px] font-semibold text-muted">{label}</p>
      <p className="mt-1 text-base font-extrabold tabular-nums text-ink">{value}</p>
      {hint && <p className="text-[13px] text-muted">{hint}</p>}
    </div>
  );
}

function ApiErrorsPanel({ job }: { job: CategorizationJob }) {
  const errors = job.api_errors ?? [];
  if (errors.length === 0 && !job.last_api_error) return null;

  const isQuota = job.last_api_error_code === 429 || errors.some(e => e.code === 429);

  return (
    <div className="rounded-m bg-warning-tint px-5 py-4">
      <p className="font-extrabold text-warning-text">
        {isQuota ? "Gemini's free quota ran out for now" : "Gemini sent back some errors"}
      </p>
      <p className="mt-1 text-[15px] text-ink-2">
        {job.failure_reason
          ?? (isQuota
            ? "Products it couldn't reach stay uncategorised. Wait a few minutes and run it again, or switch to a Lite model in Settings."
            : "Products in the failed batches stay uncategorised and will be picked up on the next run.")}
      </p>
      {job.last_api_error && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-semibold text-warning-text">
            Show what Gemini said ({errors.length || 1})
          </summary>
          <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto font-mono text-[12px] leading-snug text-ink-2">
            {(errors.length ? errors : [{ batch: 0, code: job.last_api_error_code, message: job.last_api_error, timestamp: "", products_affected: 0 }]).map((e, i) => (
              <li key={i}>
                {e.timestamp && `${e.timestamp} · `}
                {e.batch ? `batch ${e.batch} · ` : ""}
                {e.code != null ? `HTTP ${e.code} · ` : ""}
                {e.products_affected ? `${e.products_affected} products · ` : ""}
                {e.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export default function CategorizationProgressDialog({
  job,
  open,
  onClose,
  onTerminate,
  terminating = false,
}: {
  job: CategorizationJob | null;
  open: boolean;
  onClose: () => void;
  onTerminate?: () => void;
  terminating?: boolean;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  const [confirmTerminate, setConfirmTerminate] = useState(false);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.activity_log?.length]);

  useEffect(() => {
    if (!open) setConfirmTerminate(false);
  }, [open]);

  if (!job) return null;

  const running = isJobRunning(job);
  const cancelled = job.status === "cancelled";
  const done = job.status === "completed";
  const failed = job.status === "failed";
  const tokenHint = job.metrics.tokens_estimated ? "estimated" : undefined;
  const hasApiErrors = (job.api_errors?.length ?? 0) > 0 || !!job.last_api_error;
  const canTerminate = running && onTerminate && !job.cancel_requested;
  const eta = timeLeft(job);
  const unsure = job.failed_products ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sorting products into categories"
      width="max-w-[640px]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {canTerminate && !confirmTerminate && (
            <Button variant="ghost" onClick={() => setConfirmTerminate(true)}>
              Stop categorising
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-6">
        {/* Status in words */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">AI</Badge>
            {job.ai_model && <Chip size="sm">{job.ai_model}</Chip>}
            {done && !hasApiErrors && job.summary.failed === 0 && <Chip size="sm" tone="success">Finished</Chip>}
            {done && (hasApiErrors || job.summary.failed > 0) && <Chip size="sm" tone="warning">Finished, {n(job.summary.failed)} not sorted</Chip>}
            {failed && <Chip size="sm" tone="danger">Stopped by an error</Chip>}
            {cancelled && <Chip size="sm">Stopped</Chip>}
          </div>
          {running ? (
            <AiWorking>{jobWords(job)}</AiWorking>
          ) : (
            <p className="text-[15px] font-medium text-ink-2">{jobWords(job)}</p>
          )}
          <ProgressBar
            value={job.completed_products}
            max={Math.max(1, job.total_products)}
            format={() => `${Math.min(100, job.progress_pct)}%`}
          />
          <p className="text-[13px] font-medium tabular-nums text-muted">
            {n(job.completed_products)} of {n(job.total_products)} products
            {job.total_batches > 0 && ` · batch ${job.current_batch} of ${job.total_batches}`}
            {running && eta && ` · ${eta}`}
          </p>
          {running && (
            <p className="text-sm text-muted">Closing this window doesn&apos;t stop it. Categories you set by hand are never changed.</p>
          )}
        </div>

        {hasApiErrors && <ApiErrorsPanel job={job} />}

        {confirmTerminate && canTerminate && (
          <div className="rounded-m bg-warning-tint px-5 py-4">
            <p className="font-extrabold text-warning-text">Stop sorting now?</p>
            <p className="mt-1 text-[15px] text-ink-2">
              Products already sorted are saved. The rest stay uncategorised until the next run.
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-3">
              <Button variant="ghost" size="sm" onClick={() => setConfirmTerminate(false)}>
                Keep going
              </Button>
              <Button
                variant="danger"
                size="sm"
                loading={terminating}
                onClick={() => {
                  onTerminate?.();
                  setConfirmTerminate(false);
                }}
              >
                {terminating ? "Stopping…" : "Stop categorising"}
              </Button>
            </div>
          </div>
        )}

        {(done || failed || cancelled) && (
          <div>
            <p className="mb-3 text-[13px] font-semibold text-muted">What changed</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="Newly sorted" value={n(job.summary.newly_categorized)} />
              <Stat label="Re-sorted" value={n(job.summary.recategorized)} />
              <Stat label="Sorted by your rules" value={n(job.summary.rules_categorized)} />
              <Stat label="Already sorted, skipped" value={n(job.summary.already_skipped)} />
              <Stat label="Order lines updated" value={n(job.summary.items_updated)} />
              <Stat label="Time taken" value={fmtDuration(job.elapsed_s)} />
            </div>
            {job.error && <p className="mt-3 text-sm text-danger-text">{job.error}</p>}
          </div>
        )}

        {unsure.length > 0 && (
          <div className="rounded-m bg-surface px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-extrabold text-ink">{n(unsure.length)} products the AI couldn&apos;t place</p>
              <Chip size="sm" tone="warning">Not sure, check this</Chip>
            </div>
            <p className="mt-1 text-sm text-muted">
              These stay uncategorised rather than getting a guess. Run it again later, or set them by hand.
            </p>
            <ul className="mt-3 max-h-28 space-y-1 overflow-y-auto text-sm text-ink-2">
              {unsure.map(p => <li key={p} className="truncate">{p}</li>)}
            </ul>
          </div>
        )}

        <details>
          <summary className="cursor-pointer text-sm font-semibold text-accent-700">Show speed and API usage</summary>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Elapsed" value={fmtDuration(job.elapsed_s)} />
            <Stat label="Time left" value={running ? fmtDuration(job.eta_s) : "—"} />
            <Stat label="Per product" value={`${job.avg_s_per_product}s`} />
            <Stat label="Per minute" value={n(job.throughput_per_min)} />
            <Stat label="Requests sent" value={n(job.metrics.requests_sent)} />
            <Stat label="Succeeded" value={n(job.metrics.requests_ok)} />
            <Stat label="Failed" value={n(job.metrics.requests_failed)} />
            <Stat label="Retries" value={n(job.metrics.retries)} />
            <Stat label="Rate-limit waits" value={n(job.metrics.rate_limit_waits)} />
            <Stat label="Input tokens" value={n(job.metrics.input_tokens)} hint={tokenHint} />
            <Stat label="Output tokens" value={n(job.metrics.output_tokens)} hint={tokenHint} />
            <Stat label="Total tokens" value={n(job.metrics.total_tokens)} hint={tokenHint} />
          </div>
          <p className="mb-2 mt-5 text-[13px] font-semibold text-muted">Activity</p>
          <div
            ref={logRef}
            className="max-h-48 overflow-y-auto rounded-s bg-surface px-4 py-3 font-mono text-[12px] leading-relaxed text-ink-2"
          >
            {(job.activity_log ?? []).map((line, i) => {
              const isError = /API HTTP|API error|Quota|invalid JSON|Failed|cancelled/i.test(line);
              return <div key={i} className={isError ? "text-warning-text" : undefined}>{line}</div>;
            })}
          </div>
        </details>
      </div>
    </Modal>
  );
}
