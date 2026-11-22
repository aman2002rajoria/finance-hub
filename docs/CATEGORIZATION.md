# Categorization Architecture

Quick reference for AI-assisted and human modifications. Read this before
touching parsing, rules, or the Transactions / Categorize tabs.

## File map

| Concern | Primary files |
|---------|---------------|
| PDF parsing | `backend/parsers/*.py`, `backend/parsers/bank_detector.py` |
| VPA / counterparty extraction | `backend/utils/helpers.py` (`parse_description_structure`), `backend/services/categorization_service.py` (`extract_vpa`, `extract_merchant_name`) |
| Ingest pipeline | `backend/services/ingestion_service.py` |
| Rule engine | `backend/services/rule_engine.py` |
| Rule CRUD + propagation | `backend/services/categorization_service.py` |
| Category taxonomy (3-level tree) | `backend/services/category_taxonomy_service.py`, `backend/db/models.py` (`CategoryDefinition`) |
| Tagged / untagged logic | `backend/utils/tagging.py`, `frontend/lib/tagging.ts` |
| Grouping (VPA vs counterparty) | `backend/utils/grouping.py` |
| Coverage analytics | `backend/services/analytics_service.py` (`categorization_progress`), `frontend/components/CategorizationCoveragePanel.tsx` |
| Transactions API | `backend/api/routes_transactions.py` |
| Rules API | `backend/api/routes_rules.py` |
| Transactions tab UI | `frontend/app/transactions/page.tsx`, `frontend/components/InlineCategoryEditor.tsx` |
| Categorize tab UI | `frontend/app/categorize/page.tsx`, `frontend/components/categorize/*`, `frontend/components/RuleBuilder.tsx` |
| Rule engine (v2 tree) | `docs/RULE_ENGINE.md`, `backend/services/rule_condition_tree.py`, `backend/api/routes_categorize.py` |
| API client | `frontend/lib/api.ts`, `frontend/lib/types.ts` |

## Transaction parsing

Five bank parsers registered in `ingestion_service.BANK_REGISTRY`:

- SBI savings, SBI CC, Slice savings, Slice CC, Canara

Each parser returns `Transaction` dataclass fields from `parsers/base_parser.py`.
UPI rows populate `txn_vpa` and `txn_counterparty` at parse time. CC PDFs
often lack VPAs; merchant is inferred post-parse via `extract_merchant_name()`.

Ingest normalizes in `_to_row()`: parser fields first, then fallback extractors.
VPA is stored **lowercased** in `transactions.vpa`.

## VPA and counterparty

| Source | Function | When |
|--------|----------|------|
| SBI UPI | `helpers.parse_description_structure()` | Slash-delimited UPI strings |
| Slice | `slice_parser._extract_counterparty()` | UPI Credit-/Debit- pattern |
| Canara | `canara_parser._extract_counterparty()` | UPI 4th segment or NEFT name |
| Fallback | `categorization_service.extract_vpa()` | Any description with `@` handle |
| Merchant fallback | `categorization_service.extract_merchant_name()` | Aliases + canonical patterns |

## Categories and subcategories

- **Taxonomy** lives in `category_definitions` (3-level tree, expense/income).
- **Transactions** store denormalized strings: `category`, `subcategory`,
  `sub_subcategory` (not FKs — renames cascade via taxonomy service).
- **Rules** store the same triple in `categorization_rules`.

Application paths:

1. Income autotag at ingest (`apply_income_autotag`)
2. Rule engine at ingest (`RuleEngine.apply_to_dicts`)
3. Manual PATCH `/api/transactions/{id}`
4. Bulk apply `/api/transactions/bulk-apply`
5. Excel import `/api/rules/import`

## Rule matching strategy

**Selected approach: priority-based exact matching with heuristic AND-rules.**

| Priority | Rule type | Match |
|----------|-----------|-------|
| 95 | `heuristic` (combined) | `vpa_equals` AND `merchant_equals` |
| 100 | `vpa` | Exact case-insensitive VPA |
| 200 | `merchant` | Exact case-insensitive merchant |
| 250 | `keyword` | Description substring |
| 300+ | `heuristic` (other) | JSON conditions (time, amount, …) |

**Why this approach**

- **Accuracy** — VPA and merchant exact rules are fast and precise; combined
  rules (heuristic with two equals predicates) handle collisions like
  multiple merchants sharing a payment handle.
- **Maintenance** — One rules table, one engine; UI exposes three modes
  (VPA / Counterparty / Combined) that map to existing rule types.
- **Simplicity** — Users pick a mode; backend creates the right rule.
- **Extensibility** — New predicates plug into `evaluate_conditions()` without
  schema changes.

Manual edits always win over automatic re-runs unless `override=True`.

## Tagged vs untagged

**Transaction level** (`backend/utils/tagging.py`):

- **Tagged** — `category` is not null and not empty (after strip).
- **Untagged** — `category` is null or empty.
- Subcategory alone does **not** count as tagged.

**Counterparty group level** (Categorize summary table):

- **Tagged group** — `uncategorized_count == 0` (all txns in group tagged).
- **Untagged group** — `uncategorized_count > 0`.

API query param: `tag_status=tagged|untagged` on
`GET /api/transactions` and `GET /api/transactions/counterparties`.

## UI workflows

### Transactions tab

- Lists all transactions with inline `InlineCategoryEditor` (category +
  subcategory from taxonomy, auto-saves on change).
- Columns: date, account, description, amount, counterparty, VPA, category,
  subcategory, status, flags.

### Categorize tab

- **Coverage panel** at top: `GET /api/analytics/categorization-progress`
- Summary table groups by **usable VPA** → **counterparty** → unmatched
  (bank-handle VPAs like `@icici` group by merchant — see Grouping below).
- Drill-down: bulk apply with mode selector (VPA / Counterparty / Combined).

## Grouping strategy

**Selected: Option 2 + Option 1 fallback** (`backend/utils/grouping.py`)

| Confidence | Condition | Group by |
|------------|-----------|----------|
| High | Usable VPA (not bank PSP handle) | VPA |
| Medium | Bank-handle VPA or no VPA, merchant present | `merchant_name` |
| Low | Neither | Unmatched bucket |

Bank handles (`axisbank`, `icici`, `hdfcbank`, `sbi`, `@ybl`, …) are payment
rails, not merchants. Grouping by them merged unrelated payments.

**Not chosen:** ML clustering; composite keys for every row (too complex for
maintenance); VPA-only (insufficient — ~1600+ txns lack usable VPAs).

## Coverage metrics

Endpoint: `GET /api/analytics/categorization-progress`

Reconciliation rules (real-flow scope):
- `categorized_transactions + uncategorized_transactions = total_transactions`
- `categorized_vpas + uncategorized_vpas = total_vpas`
- `categorized_counterparties + uncategorized_counterparties = total_counterparties`
- `uncat_expense_amount / total_expense_amount = uncat_expense_pct`

## Transactions table column mapping

Defined in `frontend/app/transactions/page.tsx`:

| Header | Field |
|--------|-------|
| Date | `date` |
| Account | `account_name` |
| Description | `description` |
| Amount | `amount` |
| Type | `type` (Expense/Income) |
| Counterparty | `merchant_name` |
| VPA | `vpa` |
| Category | inline editor → `category` |
| Subcategory | inline editor → `subcategory` |
| Status | `isTagged(category)` |

**Bug fix (2026-06):** `category` was incorrectly listed in `SORTABLE_COLS`,
creating an extra header column and shifting all subsequent columns by one.

## Validation

Run after changes:

```bash
cd backend
python scripts/validate_categorization.py
```
