import type { CategorizationJob } from "@/lib/api";
import { fmtDuration } from "@/lib/categorization-status";

/** What the categoriser is doing right now, in plain words (design.md §11.6). */
export function jobWords(job: CategorizationJob | null | undefined): string {
  if (!job) return "Not running";
  if (job.status === "cancelled" || job.phase === "cancelled") return "Stopped. Products sorted so far are saved.";
  if (job.status === "completed" || job.phase === "completed") return "Finished sorting products";
  if (job.status === "failed" || job.phase === "failed") return "Stopped because of an error";
  if (job.cancel_requested || job.phase === "cancelling") return "Stopping after this batch…";

  const left = Math.max(0, job.total_products - job.completed_products);
  const batch = job.total_batches > 0 ? `, batch ${job.current_batch} of ${job.total_batches}` : "";

  switch (job.phase) {
    case "preparing":
      return "Getting your product list ready…";
    case "waiting_rate_limit":
      return "Waiting a moment for Gemini's rate limit…";
    case "retrying":
      return "A batch didn't come back. Trying it again…";
    default:
      return left > 0
        ? `Sorting ${left.toLocaleString("en-IN")} products into categories${batch}…`
        : "Sorting products into categories…";
  }
}

/** "about 2m 10s left", or null while there's no estimate yet. */
export function timeLeft(job: CategorizationJob | null | undefined): string | null {
  if (!job || job.eta_s == null || job.eta_s < 0) return null;
  return `about ${fmtDuration(job.eta_s)} left`;
}
