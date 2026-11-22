/**
 * Tagged vs untagged — mirrors backend/utils/tagging.py
 *
 * Tagged: category is non-null and non-empty after trim.
 * Untagged: category is null/undefined or whitespace-only.
 * Subcategory alone does NOT count as tagged.
 */
export function isTagged(category: string | null | undefined): boolean {
  return Boolean((category ?? "").trim());
}

/** Display label for status chips. */
export function tagStatusLabel(category: string | null | undefined): "tagged" | "untagged" {
  return isTagged(category) ? "tagged" : "untagged";
}

/** Counterparty group: fully tagged when no uncategorized rows remain. */
export function isGroupFullyTagged(uncategorizedCount: number, txnCount: number): boolean {
  return txnCount > 0 && uncategorizedCount === 0;
}
