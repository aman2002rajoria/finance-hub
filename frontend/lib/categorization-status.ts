import type { CategorizationJob } from "@/lib/api";

export function isJobRunning(job: CategorizationJob | null | undefined): boolean {
  return !!job && (job.status === "running" || job.status === "pending");
}

export function isJobTerminal(job: CategorizationJob | null | undefined): boolean {
  return !!job && ["completed", "failed", "cancelled"].includes(job.status);
}

export function jobPhaseLabel(job: CategorizationJob | null | undefined): string {
  if (!job) return "Idle";
  if (job.status === "cancelled" || job.phase === "cancelled") return "Cancelled";
  if (job.status === "completed" || job.phase === "completed") return "Completed";
  if (job.status === "failed" || job.phase === "failed") return "Failed";
  if (job.cancel_requested || job.phase === "cancelling") return "Cancelling…";

  switch (job.phase) {
    case "preparing":
      return "Preparing…";
    case "categorizing":
      return "Categorizing…";
    case "waiting_rate_limit":
      return "Waiting for Rate Limit…";
    case "retrying":
      return "Retrying…";
    default:
      return job.status === "running" ? "Categorizing…" : "Idle";
  }
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}
