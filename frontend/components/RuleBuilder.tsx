"use client";

import clsx from "clsx";
import { Plus, Trash2 } from "lucide-react";

import { conditionsText } from "@/components/ledger/ruleText";
import { Button, IconButton, Input, Segmented, Select } from "@/components/ui";
import {
  MONTHS, RULE_FIELDS, TYPE_VALUES,
  needsNoValue, needsSecondValue, newCondition, newGroup, opsForField,
} from "@/lib/ruleBuilder";
import type { ConditionTree, RuleCondition, RuleConditionGroup } from "@/lib/types";

interface Props {
  tree: ConditionTree;
  onChange: (tree: ConditionTree) => void;
  depth?: number;
  onRemove?: () => void;
}

// Compact pill selects for condition rows.
const ROW = "!h-10 !text-sm";

/** Visual condition builder: all/any, nested groups, surface rows (design.md §7). */
export function RuleBuilder({ tree, onChange, depth = 0, onRemove }: Props) {
  const items = tree.items ?? [];

  function updateItems(next: ConditionTree["items"]) {
    onChange({ ...tree, items: next });
  }
  function updateItem(idx: number, next: RuleCondition | RuleConditionGroup) {
    const copy = [...items];
    copy[idx] = next;
    updateItems(copy);
  }

  return (
    <div className={clsx("space-y-2", depth > 0 && "rounded-m p-4 shadow-flat")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink-2">{depth === 0 ? "Match" : "In this group, match"}</span>
        <Segmented
          size="sm"
          ariaLabel="How conditions combine"
          value={tree.logic}
          onChange={v => onChange({ ...tree, logic: v })}
          options={[
            { value: "and" as const, label: "All of these" },
            { value: "or" as const, label: "Any of these" },
          ]}
        />
        {onRemove && (
          <IconButton size="sm" aria-label="Remove group" title="Remove group" onClick={onRemove} className="ml-auto">
            <Trash2 className="h-4 w-4" strokeWidth={1.75} />
          </IconButton>
        )}
      </div>

      {items.length === 0 && (
        <p className="py-1 text-sm text-muted">Add at least one condition.</p>
      )}

      {items.map((item, idx) =>
        item.type === "group" ? (
          <RuleBuilder
            key={item.id || idx}
            tree={{ version: 2, logic: item.logic, items: item.items }}
            depth={depth + 1}
            onChange={sub => updateItem(idx, { ...item, logic: sub.logic, items: sub.items })}
            onRemove={() => updateItems(items.filter((_, i) => i !== idx))}
          />
        ) : (
          <ConditionRow
            key={item.id || idx}
            condition={item}
            onChange={c => updateItem(idx, c)}
            onRemove={() => updateItems(items.filter((_, i) => i !== idx))}
          />
        ),
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={() => updateItems([...items, newCondition()])}>
          <Plus className="h-4 w-4" strokeWidth={1.75} /> Add condition
        </Button>
        {depth === 0 && (
          <Button variant="ghost" size="sm" onClick={() => updateItems([...items, newGroup("or")])}>
            <Plus className="h-4 w-4" strokeWidth={1.75} /> Add a group
          </Button>
        )}
      </div>
    </div>
  );
}

function ConditionRow({
  condition, onChange, onRemove,
}: {
  condition: RuleCondition;
  onChange: (c: RuleCondition) => void;
  onRemove: () => void;
}) {
  const fieldMeta = RULE_FIELDS.find(f => f.value === condition.field);
  const ops = opsForField(condition.field);
  const noVal = needsNoValue(condition.op);
  const twoVal = needsSecondValue(condition.op);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-m bg-surface p-2.5">
      <Select
        aria-label="Field"
        value={condition.field}
        onChange={e => {
          const field = e.target.value;
          const defaultOp = opsForField(field)[0]?.value || "contains";
          onChange({ ...condition, field, op: defaultOp, value: "", value2: undefined });
        }}
        className={clsx(ROW, "!w-auto min-w-[150px] flex-1 !bg-card")}
      >
        {RULE_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
      </Select>
      <Select
        aria-label="Operator"
        value={condition.op}
        onChange={e => onChange({ ...condition, op: e.target.value })}
        className={clsx(ROW, "!w-auto min-w-[140px] flex-1 !bg-card")}
      >
        {ops.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
      {!noVal && (
        <div className="min-w-[140px] flex-1">
          {fieldMeta?.kind === "type" ? (
            <Select aria-label="Value" value={String(condition.value || "expense")} onChange={e => onChange({ ...condition, value: e.target.value })} className={clsx(ROW, "!bg-card")}>
              {TYPE_VALUES.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
            </Select>
          ) : fieldMeta?.kind === "date" && condition.op === "month_is" ? (
            <Select aria-label="Month" value={String(condition.value || "1")} onChange={e => onChange({ ...condition, value: e.target.value })} className={clsx(ROW, "!bg-card")}>
              {MONTHS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </Select>
          ) : fieldMeta?.kind === "date" ? (
            <Input aria-label="Date" type="date" value={String(condition.value || "")} onChange={e => onChange({ ...condition, value: e.target.value })} className={clsx(ROW, "!bg-card")} />
          ) : fieldMeta?.kind === "numeric" ? (
            <Input
              aria-label="Amount in rupees"
              type="number"
              value={condition.value ?? ""}
              onChange={e => onChange({ ...condition, value: e.target.value ? Number(e.target.value) : "" })}
              className={clsx(ROW, "!bg-card")}
              placeholder="₹"
            />
          ) : (
            <Input
              aria-label="Value"
              value={String(condition.value || "")}
              onChange={e => onChange({ ...condition, value: e.target.value })}
              className={clsx(ROW, "!bg-card")}
              placeholder="swiggy"
            />
          )}
        </div>
      )}
      {twoVal && (
        <div className="min-w-[120px] flex-1">
          {fieldMeta?.kind === "date" ? (
            <Input aria-label="To date" type="date" value={String(condition.value2 || "")} onChange={e => onChange({ ...condition, value2: e.target.value })} className={clsx(ROW, "!bg-card")} />
          ) : (
            <Input
              aria-label="Up to"
              type="number"
              value={condition.value2 ?? ""}
              onChange={e => onChange({ ...condition, value2: e.target.value ? Number(e.target.value) : "" })}
              className={clsx(ROW, "!bg-card")}
              placeholder="up to ₹"
            />
          )}
        </div>
      )}
      <IconButton size="sm" aria-label="Remove condition" title="Remove condition" onClick={onRemove}>
        <Trash2 className="h-4 w-4" strokeWidth={1.75} />
      </IconButton>
    </div>
  );
}

/** Read-only plain-words summary for rule lists. */
export function RuleConditionsSummary({ tree }: { tree: ConditionTree | null | undefined }) {
  const text = conditionsText(tree);
  return <span className="text-sm text-muted">{text ? text.charAt(0).toUpperCase() + text.slice(1) : "No conditions"}</span>;
}
