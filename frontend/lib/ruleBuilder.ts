// Condition-tree helpers for the UI rule builder.
// Mirrors backend/services/rule_condition_tree.py — keep in sync.

import type { CategoryKind, ConditionTree, RuleCondition, RuleConditionGroup } from "./types";

export const RULE_FIELDS: { value: string; label: string; kind: "text" | "numeric" | "date" | "category" | "type" }[] = [
  { value: "description", label: "Description", kind: "text" },
  { value: "raw_description", label: "Statement text", kind: "text" },
  { value: "counterparty", label: "Counterparty", kind: "text" },
  { value: "vpa", label: "VPA", kind: "text" },
  { value: "amount", label: "Amount", kind: "numeric" },
  { value: "type", label: "Money in or out", kind: "type" },
  { value: "date", label: "Date", kind: "date" },
  { value: "category", label: "Category", kind: "category" },
  { value: "subcategory", label: "Subcategory", kind: "category" },
];

export const TEXT_OPS = [
  { value: "contains", label: "Contains" },
  { value: "not_contains", label: "Does not contain" },
  { value: "equals", label: "Is" },
  { value: "not_equals", label: "Is not" },
  { value: "starts_with", label: "Starts with" },
  { value: "ends_with", label: "Ends with" },
  { value: "regex", label: "Matches pattern (regex)" },
  { value: "is_empty", label: "Is empty" },
  { value: "is_not_empty", label: "Is not empty" },
];

export const NUM_OPS = [
  { value: "eq", label: "Is" },
  { value: "neq", label: "Is not" },
  { value: "gt", label: "More than" },
  { value: "gte", label: "At least" },
  { value: "lt", label: "Less than" },
  { value: "lte", label: "At most" },
  { value: "between", label: "Between" },
];

export const DATE_OPS = [
  { value: "before", label: "Before" },
  { value: "after", label: "After" },
  { value: "between", label: "Between" },
  { value: "month_is", label: "Month is" },
  { value: "day_of_month", label: "Day of month is" },
  { value: "year_is", label: "Year is" },
];

export const CAT_OPS = [
  { value: "equals", label: "Is" },
  { value: "not_equals", label: "Is not" },
  { value: "is_empty", label: "Is empty" },
  { value: "is_not_empty", label: "Is not empty" },
];

export const TYPE_VALUES = [
  { value: "expense", label: "Money out (expense)" },
  { value: "income", label: "Money in (income)" },
];

export const MONTHS = [
  { value: "1", label: "January" },
  { value: "2", label: "February" },
  { value: "3", label: "March" },
  { value: "4", label: "April" },
  { value: "5", label: "May" },
  { value: "6", label: "June" },
  { value: "7", label: "July" },
  { value: "8", label: "August" },
  { value: "9", label: "September" },
  { value: "10", label: "October" },
  { value: "11", label: "November" },
  { value: "12", label: "December" },
];

let _id = 0;
export function newId(): string {
  _id += 1;
  return `c${_id}`;
}

export function emptyTree(): ConditionTree {
  return { version: 2, logic: "and", items: [] };
}

export function newCondition(partial?: Partial<RuleCondition>): RuleCondition {
  return {
    type: "condition",
    id: newId(),
    field: "description",
    op: "contains",
    value: "",
    ...partial,
  };
}

export function newGroup(logic: "and" | "or" = "or"): RuleConditionGroup {
  return { type: "group", id: newId(), logic, items: [] };
}

export function opsForField(field: string) {
  const meta = RULE_FIELDS.find(f => f.value === field);
  if (!meta) return TEXT_OPS;
  if (meta.kind === "numeric") return NUM_OPS;
  if (meta.kind === "date") return DATE_OPS;
  if (meta.kind === "category") return CAT_OPS;
  if (meta.kind === "type") return [{ value: "equals", label: "Is" }];
  return TEXT_OPS;
}

export function needsSecondValue(op: string): boolean {
  return op === "between";
}

export function needsNoValue(op: string): boolean {
  return op === "is_empty" || op === "is_not_empty";
}

/** Build a v2 tree from a categorize group row. */
export function treeFromGroup(
  kind: "vpa" | "merchant" | "combined",
  group: { key: string; label: string },
): ConditionTree {
  if (kind === "vpa") {
    return {
      version: 2,
      logic: "and",
      items: [newCondition({ field: "vpa", op: "equals", value: group.label })],
    };
  }
  if (kind === "merchant") {
    return {
      version: 2,
      logic: "and",
      items: [newCondition({ field: "counterparty", op: "equals", value: group.label })],
    };
  }
  const raw = group.key.replace(/^combined:/, "");
  const [mch, vpa] = raw.split("|");
  const merchantLabel = group.label.split(" · ")[0]?.trim() || mch;
  return {
    version: 2,
    logic: "and",
    items: [
      newCondition({ field: "counterparty", op: "equals", value: merchantLabel }),
      newCondition({ field: "vpa", op: "equals", value: vpa || "" }),
    ],
  };
}

/** Strip UI-only ids before sending to API. */
export function serializeTree(tree: ConditionTree): ConditionTree {
  const walk = (items: (RuleCondition | RuleConditionGroup)[]): unknown[] =>
    items.map(item => {
      if (item.type === "group") {
        return { type: "group", logic: item.logic, items: walk(item.items) };
      }
      const c: Record<string, unknown> = {
        type: "condition",
        field: item.field,
        op: item.op,
      };
      if (item.value !== undefined && item.value !== "") c.value = item.value;
      if (item.value2 !== undefined && item.value2 !== "") c.value2 = item.value2;
      return c;
    });
  return { version: 2, logic: tree.logic, items: walk(tree.items) as ConditionTree["items"] };
}

export function parseCombinedKey(key: string): { merchant: string; vpa: string } {
  const raw = key.replace(/^combined:/, "");
  const [merchant, vpa] = raw.split("|");
  return { merchant: merchant || "", vpa: vpa || "" };
}

export function inferKindFromCategory(
  category: string | null,
  taxonomy: { expense: { name: string }[]; income: { name: string }[] } | undefined,
): CategoryKind {
  if (!category || !taxonomy) return "expense";
  if (taxonomy.income.some(n => n.name === category)) return "income";
  return "expense";
}
