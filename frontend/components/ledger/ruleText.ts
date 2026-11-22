// Plain-words descriptions of rules, used for "Why this?" explanations and
// the rule list (design.md §11.3: explain in plain words, two or three sentences).

import { inr } from "@/lib/format";
import { MONTHS, RULE_FIELDS, opsForField } from "@/lib/ruleBuilder";
import type {
  CategorizationRule, ConditionTree, RuleCondition, RuleConditionGroup, RuleConditions,
} from "@/lib/types";

export type RuleKind = "vpa" | "merchant" | "keyword" | "combined" | "custom";

export const RULE_KIND_LABEL: Record<RuleKind, string> = {
  vpa: "VPA",
  merchant: "Merchant",
  keyword: "Keyword",
  combined: "Merchant + VPA",
  custom: "Custom",
};

export function isTree(c: RuleConditions | ConditionTree | null | undefined): c is ConditionTree {
  return !!c && (c.version === 2 || Array.isArray(c.items));
}

export function ruleKind(rule: Pick<CategorizationRule, "rule_type" | "conditions">): RuleKind {
  if (rule.rule_type === "vpa") return "vpa";
  if (rule.rule_type === "merchant") return "merchant";
  if (rule.rule_type === "keyword") return "keyword";
  const c = rule.conditions as Record<string, unknown> | null;
  if (c && "vpa_equals" in c && "merchant_equals" in c) return "combined";
  return "custom";
}

export function ruleTitle(rule: Pick<CategorizationRule, "name" | "rule_value" | "rule_type" | "conditions">): string {
  // Auto-generated names like "Vpa: swiggy@icici" repeat the type chip; keep the value.
  if (rule.name) return rule.name.replace(/^(vpa|merchant|keyword)\s*:\s*/i, "");
  return rule.rule_value;
}

function fieldLabel(field: string): string {
  return (RULE_FIELDS.find(f => f.value === field)?.label ?? field).toLowerCase().replace("vpa", "VPA");
}

function opLabel(field: string, op: string): string {
  return (opsForField(field).find(o => o.value === op)?.label ?? op).toLowerCase();
}

function valueText(c: RuleCondition): string {
  if (c.field === "amount") {
    const a = Number(c.value);
    const b = Number(c.value2);
    return c.op === "between" ? `${inr(a)} and ${inr(b)}` : inr(a);
  }
  if (c.field === "type") return c.value === "income" ? "money in" : "money out";
  if (c.op === "month_is") return MONTHS.find(m => m.value === String(c.value))?.label ?? String(c.value);
  if (c.op === "between") return `${c.value} and ${c.value2}`;
  return `“${c.value ?? ""}”`;
}

function conditionText(c: RuleCondition): string {
  if (c.op === "is_empty" || c.op === "is_not_empty") return `${fieldLabel(c.field)} ${opLabel(c.field, c.op)}`;
  return `${fieldLabel(c.field)} ${opLabel(c.field, c.op)} ${valueText(c)}`;
}

function itemsText(items: (RuleCondition | RuleConditionGroup)[], logic: "and" | "or"): string {
  const parts = items.map(i => (i.type === "group" ? `(${itemsText(i.items, i.logic)})` : conditionText(i)));
  return parts.join(logic === "and" ? " and " : " or ");
}

/** "VPA is “swiggy@icici” and amount more than ₹500". */
export function conditionsText(c: RuleConditions | ConditionTree | null | undefined): string {
  if (!c) return "";
  if (isTree(c)) return c.items?.length ? itemsText(c.items, c.logic ?? "and") : "";
  const bits: string[] = [];
  const legacy = c as RuleConditions & { vpa_equals?: string; merchant_equals?: string };
  if (legacy.merchant_equals) bits.push(`merchant is “${legacy.merchant_equals}”`);
  if (legacy.vpa_equals) bits.push(`VPA is “${legacy.vpa_equals}”`);
  if (c.type) bits.push(c.type === "credit" ? "money in" : "money out");
  if (c.txn_mode) bits.push(`paid by ${Array.isArray(c.txn_mode) ? c.txn_mode.join(" or ") : c.txn_mode}`);
  if (c.account_type) bits.push(c.account_type === "credit_card" ? "on a credit card" : "from a savings account");
  if (c.amount?.min != null) bits.push(`at least ${inr(c.amount.min)}`);
  if (c.amount?.max != null) bits.push(`at most ${inr(c.amount.max)}`);
  if (c.day_of_week?.length) bits.push(`on ${c.day_of_week.join(", ")}`);
  if (c.time_of_day?.start || c.time_of_day?.end) {
    bits.push(`between ${c.time_of_day.start ?? "00:00"} and ${c.time_of_day.end ?? "23:59"}`);
  }
  if (c.description_contains) bits.push(`description contains “${c.description_contains}”`);
  if (c.vpa_contains) bits.push(`VPA contains “${c.vpa_contains}”`);
  if (c.merchant_contains) bits.push(`merchant contains “${c.merchant_contains}”`);
  return bits.join(", ");
}

/** What the rule matches, as a short phrase for list rows. */
export function ruleMatchText(rule: Pick<CategorizationRule, "rule_type" | "rule_value" | "conditions">): string {
  switch (rule.rule_type) {
    case "vpa": return `VPA is ${rule.rule_value}`;
    case "merchant": return `Merchant is ${rule.rule_value}`;
    case "keyword": return `Description contains “${rule.rule_value}”`;
    default: {
      const t = conditionsText(rule.conditions);
      return t ? t.charAt(0).toUpperCase() + t.slice(1) : "No conditions";
    }
  }
}

/**
 * The rule as a sentence's opening clause, split so the value can be bold:
 * "When paid to" + "swiggy@icici". Custom rules carry their whole condition
 * in `lead` and no separate value.
 */
export function ruleWhen(
  rule: Pick<CategorizationRule, "rule_type" | "rule_value" | "conditions" | "category">,
): { lead: string; value: string | null } {
  const incoming = /income|salary|refund|cashback|interest|dividend/i.test(rule.category ?? "");
  switch (rule.rule_type) {
    case "vpa": return { lead: incoming ? "When paid by" : "When paid to", value: rule.rule_value };
    case "merchant": return { lead: "When the merchant is", value: rule.rule_value };
    case "keyword": return { lead: "When the description mentions", value: rule.rule_value };
    default: {
      const t = conditionsText(rule.conditions);
      return { lead: t ? `When ${t}` : "When nothing is set", value: null };
    }
  }
}
