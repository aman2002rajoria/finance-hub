/** Generic drill-down selection — URL-serializable. */

export type BlinkitDrillDimension =
  | "all"
  | "category"
  | "subcategory"
  | "product"
  | "store"
  | "seller"
  | "brand"
  | "state"
  | "address"
  | "month"
  | "day"
  | "weekday"
  | "bucket"
  | "has_discount"
  | "has_delivery"
  | "has_handling"
  | "has_convenience"
  | "has_tax";

export type BlinkitChargeType = "delivery" | "handling" | "convenience";

export interface BlinkitDrillSelection {
  dimension: BlinkitDrillDimension;
  value?: string;
  charge_type?: BlinkitChargeType;
  discounted_only?: boolean;
  tax_only?: boolean;
  category_filter?: string;
  source?: string;
  initialTab?: "orders" | "products";
}

const BOOL_KEYS = ["discounted_only", "tax_only"] as const;

export function drillSelectionToParams(sel: BlinkitDrillSelection): Record<string, string> {
  const out: Record<string, string> = { dimension: sel.dimension };
  if (sel.value) out.value = sel.value;
  if (sel.charge_type) out.charge_type = sel.charge_type;
  if (sel.category_filter) out.category_filter = sel.category_filter;
  if (sel.source) out.source = sel.source;
  if (sel.initialTab) out.tab = sel.initialTab;
  for (const k of BOOL_KEYS) {
    if (sel[k]) out[k] = "1";
  }
  return out;
}

export function paramsToDrillSelection(
  params: URLSearchParams,
): BlinkitDrillSelection | null {
  const dimension = params.get("dimension");
  if (!dimension) return null;
  return {
    dimension: dimension as BlinkitDrillDimension,
    value: params.get("value") ?? undefined,
    charge_type: (params.get("charge_type") as BlinkitChargeType) ?? undefined,
    category_filter: params.get("category_filter") ?? undefined,
    discounted_only: params.get("discounted_only") === "1",
    tax_only: params.get("tax_only") === "1",
    source: params.get("source") ?? undefined,
    initialTab: (params.get("tab") as "orders" | "products") ?? undefined,
  };
}

export function buildDrilldownHref(
  sel: BlinkitDrillSelection,
  extra?: Record<string, string | number | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...drillSelectionToParams(sel), ...extra })) {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  }
  return `/blinkit/analytics/drilldown?${sp.toString()}`;
}

export function drillBreadcrumbs(sel: BlinkitDrillSelection): { label: string; href?: string }[] {
  const crumbs: { label: string; href?: string }[] = [
    { label: "Overview", href: "/blinkit/analytics" },
  ];
  if (sel.source) crumbs.push({ label: sel.source });
  if (sel.value) crumbs.push({ label: sel.value });
  else if (!sel.source) crumbs.push({ label: sel.dimension.replace(/_/g, " ") });
  return crumbs;
}

export function drillLabel(sel: BlinkitDrillSelection): string {
  return drillBreadcrumbs(sel).map(c => c.label).join(" › ");
}
