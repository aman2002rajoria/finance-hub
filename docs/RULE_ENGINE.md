# Rule Engine (UI-First Categorization)

Visual rule builder for Finance Hub. No SQL — all conditions are stored as
JSON and evaluated in Python.

## Priority order

1. **Manual override** — `categorization_source = manual` is never overwritten by rule apply.
2. **Rules** — lower `priority` number wins (10 beats 20).
3. **Uncategorized** — empty / whitespace `category`.

## File map

| Concern | Files |
|---------|-------|
| v2 condition tree evaluator | `backend/services/rule_condition_tree.py` |
| Legacy + tree routing | `backend/services/rule_engine.py` |
| Group / preview / analytics | `backend/services/categorize_ui_service.py` |
| Categorize API | `backend/api/routes_categorize.py` |
| Apply / reorder API | `backend/api/routes_rules.py` (`POST /apply-tree`, `POST /reorder`) |
| Rule builder UI | `frontend/components/RuleBuilder.tsx` |
| Preview dialog | `frontend/components/RulePreviewDialog.tsx` |
| Categorize tabs | `frontend/app/categorize/page.tsx`, `frontend/components/categorize/*` |
| Tree helpers | `frontend/lib/ruleBuilder.ts` |
| Types | `frontend/lib/types.ts` (`ConditionTree`, `RuleCondition`) |

## Condition tree format (v2)

```json
{
  "version": 2,
  "logic": "and",
  "items": [
    {"type": "condition", "field": "description", "op": "contains", "value": "AMAZON"},
    {"type": "condition", "field": "amount", "op": "between", "value": 500, "value2": 2000},
    {
      "type": "group",
      "logic": "or",
      "items": [
        {"type": "condition", "field": "counterparty", "op": "equals", "value": "SWIGGY"},
        {"type": "condition", "field": "description", "op": "contains", "value": "SWIGGY"}
      ]
    }
  ]
}
```

### Fields

| UI field | DB column | Notes |
|----------|-----------|-------|
| Description | `description` | Display / cleaned description |
| Raw Description | `raw_text` | Falls back to `description` if empty |
| Counterparty | `merchant_name` | Canonical merchant |
| VPA | `vpa` | Lowercased at ingest |
| Amount | `amount` | Numeric |
| Income / Expense | `type` | expense→debit, income→credit |
| Date | `date` | ISO date |
| Category | `category` | |
| Subcategory | `subcategory` | |

Text matching is **case-insensitive** and collapses whitespace.

### Preview vs apply filters

- **Preview** defaults to `only_uncategorized: false` so you can verify rules against already-tagged rows.
- **Apply** defaults to `only_uncategorized: true` so existing categories are not overwritten.
- Toggle both in the UI. Preview response includes `rows_evaluated`, `rows_skipped_tagged`, `rows_total`.

### Operators

- **Text:** contains, not_contains, equals, not_equals, starts_with, ends_with, regex, is_empty, is_not_empty
- **Numeric:** eq, neq, gt, gte, lt, lte, between
- **Date:** before, after, between, month_is, day_of_month, year_is
- **Category:** equals, not_equals, is_empty, is_not_empty

## API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/categorize/groups?kind=vpa\|merchant\|combined` | Tab group tables |
| GET | `/api/categorize/review-queues` | Top uncategorized by amount |
| GET | `/api/categorize/rule-analytics` | Rule coverage stats |
| POST | `/api/categorize/preview-rule` | Preview matches (no writes) |
| POST | `/api/rules/apply-tree` | Save + apply v2 rule |
| POST | `/api/rules/reorder` | `{ rule_ids: [id, ...] }` priority |

## UI workflow

1. **By VPA / Counterparty / Combined** — browse groups, bulk categorize, or "Create rule".
2. **Rules tab** — visual builder (AND/OR/nested groups), Preview → Save / Save & Apply.
3. **Review queues** — prioritize high-value uncategorized items.
4. **Coverage panel** — reconciles categorized + uncategorized = total (real-flow scope).

## Real-flow scope

Coverage and group endpoints exclude internal transfers, CC bill payments, and EMI lump-sums (same as `CategorizationCoveragePanel`). Full ledger count may be higher — see `docs/CATEGORIZATION.md`.

## Validation

```bash
cd backend && python scripts/validate_categorization.py
```

Checks tagging, bulk apply, tree AND/OR evaluation, manual override skip, and coverage reconciliation.
