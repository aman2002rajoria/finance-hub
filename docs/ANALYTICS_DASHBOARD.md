# Personal Financial Analytics — Dashboard Design Spec

> **Objective:** Transition Finance Hub from a categorization tool into a personal financial analytics product. Every view must answer a financial question in a top-down, hierarchical story — not add charts for their own sake.

---

## 1. Design Philosophy

Analytics answers questions in order:

| Level | Question | Dashboard section |
|-------|----------|-------------------|
| **1 — Financial Health** | Am I saving? Is my position improving? How much came in vs went out? | §1 Financial Snapshot |
| **2 — Why?** | What categories drive expenses/income? How have they changed? | §2 Sankey, §3 Trends, §4–5 Breakdowns |
| **3 — Details** | Which merchants/VPAs matter? What needs review? | §6 Deep Dive Tables |
| **4 — Audit** | Why is this transaction here? Which rule? Can I trace it? | Transactions + Categorize (existing) |

---

## 2. Wireframe & Layout (Top → Bottom)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  GLOBAL DATE FILTER  [Last 1M] [3M] [6M] [12M] [All]  From ___ To ___  │
│  "Every metric below uses this window"                                   │
└─────────────────────────────────────────────────────────────────────────┘

┌─ §1 FINANCIAL SNAPSHOT ────────────────────────────────────────────────┐
│  CASH FLOW                    │  TRUE PERSONAL ECONOMICS                 │
│  ┌─────────┬─────────┬───────┐│  Income (true)     ₹X                    │
│  │ Money In│ Money Out│ Net  ││    Salary / Interest / Dividends / Other │
│  └─────────┴─────────┴───────┘│  Refunds/Recoveries ₹Y  (separate)       │
│  Net = In − Out               │  Expenses (gross)   ₹A                    │
│                               │  − Refunds          ₹B                    │
│  SAVINGS (hero metric)        │  = Net Personal Spend ₹C                  │
│  ┌───────────────────────────┐│  Savings = True Income − Net Spend = ₹S  │
│  │  ₹S  (large, primary)     ││  Savings rate %                           │
│  └───────────────────────────┘│                                           │
│  Internal transfers / CC pay  │  (collapsed footnote — not in savings)   │
└─────────────────────────────────────────────────────────────────────────┘

┌─ §2 MONEY FLOW SANKEY (centerpiece) ─────────────────────────────────────┐
│  [Single period]  Opening → Income sources → Available → Expense cats    │
│                   → Savings → Closing                                     │
│  [Expand node]    Food → Restaurants → Swiggy, Zomato…                   │
│  [Multi-month]    Jan close → Feb open → Feb flow → Feb close → …       │
└─────────────────────────────────────────────────────────────────────────┘

┌─ §3 TRENDS ──────────────────────────────────────────────────────────────┐
│  Balance / Net worth (carry-forward)  │  Monthly: Income | Expense | Save │
└─────────────────────────────────────────────────────────────────────────┘

┌─ §4 INCOME BREAKDOWN ────────────────────────────────────────────────────┐
│  True income by source (% + amount)  │  Refunds/recoveries (separate card)│
└─────────────────────────────────────────────────────────────────────────┘

┌─ §5 EXPENSE BREAKDOWN ───────────────────────────────────────────────────┐
│  Category table/chart  →  click drills: Subcategory → Counterparty → Txn │
└─────────────────────────────────────────────────────────────────────────┘

┌─ §6 DEEP DIVE (lower on page) ───────────────────────────────────────────┐
│  Top Counterparties │ Top VPAs │ CC Reconciliation │ Uncategorized queue │
└─────────────────────────────────────────────────────────────────────────┘
```

### Section rationale

| Section | Why it exists | What it must NOT do |
|---------|---------------|---------------------|
| **§1 Snapshot** | Answers “Am I saving?” in 5 seconds | Duplicate Sankey detail |
| **§2 Sankey** | Shows *where money flowed* — the story | Replace ledger; show every VPA by default |
| **§3 Trends** | Answers “Is behavior changing?” | Add 10 more line charts |
| **§4 Income** | Separates *earnings* from *recoveries* | Treat refunds as salary |
| **§5 Expense** | Explains consumption | Mix internal transfers into spend |
| **§6 Deep dive** | Operational drill-down | Appear above savings hero |

---

## 3. Metrics & Formulas

### 3.1 Cash Flow (includes everything that moved)

| Metric | Formula | Includes refunds? | Includes internal/CC pay? |
|--------|---------|-------------------|---------------------------|
| **Money In** | Σ savings credits (non-internal) | ✅ Yes | ❌ No |
| **Money Out** | Σ real debits + EMI − refunds | Net of refunds | ❌ No internal/CC pay |
| **Net Cash Flow** | Money In − Money Out | — | — |

### 3.2 True Personal Economics (excludes recoveries from income)

| Metric | Formula |
|--------|---------|
| **True Income** | Σ savings credits where `is_refund = false` |
| **Refunds / Recoveries** | Σ credits where `is_refund = true` (shown separately) |
| **Gross Expenses** | Real spend before refund offset |
| **Net Personal Spend** | Gross Expenses − Refunds applied to spend buckets |
| **Savings** | True Income − Net Personal Spend |
| **Savings Rate** | Savings / True Income × 100 |

> **Key insight:** Cash flow counts refund credits as “money in.” Personal economics treats them as spend offsets, not earnings.

### 3.3 Balance reconciliation (per period)

```
Opening Balance
+ Money In (cash flow definition)
− Money Out (cash flow definition)
= Closing Balance
```

Balance trend uses **carry-forward EOD balances** from savings statements (already implemented). Sankey opening/closing must reconcile to these values per period.

---

## 4. Sankey Design

### 4.1 Default single-period flow

```
Opening Balance ──┐
                  ├──► Available Funds ──► Expense Categories ──► Net Savings ──► Closing Balance
Salary ───────────┤         ▲
Interest ─────────┤         │
Other Income ─────┘         │
Refunds ────────────────────┘  (side branch — reduces effective spend, not income)
```

**Node layers (left → right):**

1. **Sources:** Opening balance, income subcategories, refunds (visual branch)
2. **Pool:** Available funds (= opening + inflows)
3. **Uses:** Expense categories (top N + Other)
4. **Outcome:** Net savings, closing balance

### 4.2 Reconciliation rules

Every Sankey link must satisfy:

| Check | Rule |
|-------|------|
| **Conservation** | Σ inflows − Σ outflows = Δ balance |
| **No double count** | Internal transfers and CC bill payments never appear as expense nodes |
| **Refund handling** | Refund credits reduce expense category links OR appear as return-from-expense edge — never as income node |
| **EMI** | Lump-sum EMI debits excluded; projected instalments folded into expense categories |
| **Period boundary** | Opening/closing for month M match balance trend at month start/end |

### 4.3 Expandable drill-down

Default: category level only.

On expand:

```
Food (₹12,000)
  └─ Restaurants (₹8,000)
       └─ Swiggy (₹5,200)  [counterparty]
       └─ …
```

Backend endpoint: `GET /api/analytics/sankey?date_from&date_to&expand=Food/Restaurants`

Returns `{ nodes: [{id, label, layer, amount}], links: [{source, target, value}] }`.

### 4.4 Multi-month Sankey (Phase 2)

Chain months via closing → opening links:

```
Jan Close ──► Feb Open ──► Feb Income ──► Feb Expenses ──► Feb Close ──► Mar Open ──► …
```

Defer until single-period Sankey validates cleanly.

---

## 5. Global Date Filter

### 5.1 Target architecture

- **Single source of truth:** React context (`DateRangeProvider`) in `app/layout.tsx`
- Default: Last 3 months (or All time — product decision)
- Persist in `localStorage` optional
- **Merge `/` dashboard and `/analytics`** into one `/` route with this filter sticky at top

### 5.2 Current state (as of this spec)

| Surface | Date filter | Status |
|---------|-------------|--------|
| `/analytics` | Page-local `useState` | ✅ Most hooks pass `dr` |
| `/` dashboard | None | ❌ Always all-time |
| `/transactions` | Own filters | ❌ Isolated |
| `/categorize` | None (`useProgress()`) | ❌ All-time |
| Balance / net worth | Clips window, carry-forward values | ✅ By design |

### 5.3 Bugs found & fixed

| Issue | Root cause | Fix |
|-------|------------|-----|
| CC reconciliation ignored filter | Route + hook had no date params | Added `date_from`/`date_to` to API + `useCCReconciliation(dr)` |
| EMI in `monthly_series` / `category_breakdown` | All instalments projected regardless of window | Centralized `_iter_emi_instalments()` |
| EMI missing in `monthly_by_category` | Never folded in | Added EMI via same helper |
| Preset pill false positive | Month diff only, not `date_to === today` | Preset requires end date = today |

### 5.4 Intentional exceptions

| Behavior | Reason |
|----------|--------|
| Balance trend computes from full history, clips display | First point in window must show real carry-forward balance, not zero |
| Counterparty summary on Categorize drawer | All-time review context (optional date param later) |

---

## 6. Refund / Reimbursement Model

### 6.1 Current model (keep, extend)

Today:

- `is_refund: bool` on `Transaction`
- `refund_category: str` — spend bucket the refund offsets
- Analytics excludes refunds from `_real_income_where`
- Refunds subtract from spend in `headline`, `category_breakdown`, etc.

### 6.2 Proposed `flow_type` (Phase 1.5)

Add computed or stored classification:

| flow_type | Detection | Analytics treatment |
|-----------|-----------|-------------------|
| `income` | savings credit, not refund, not internal | True income |
| `expense` | real debit | Spend |
| `refund` | `is_refund=true` | Offset spend; separate UI card |
| `transfer` | internal or CC payment | Excluded from personal economics |

**Refund sub-types** (via `subcategory` or new `refund_type` enum):

- `Shared Expense Recovery` — friend paying back
- `Merchant Refund` — Amazon return, etc.
- `Reimbursement` — employer/expense report

Implementation path:

1. Add taxonomy nodes under a `Refunds & Recoveries` income-kind root (for picker UX)
2. On credit + refund flag, set `subcategory` to recovery type
3. Extend `income_detail()` with `refunds_by_type[]`
4. Auto-tag regex in `categorization_service.py` for common patterns

**Do not** inflate true income. Cash flow KPI still includes refund credits in Money In.

---

## 7. Validation Checks

### 7.1 Automated script (`backend/scripts/validate_analytics.py` — to build)

```python
# For arbitrary date window:
assert abs(money_in - money_out - net_cash_flow) < 0.01
assert abs(true_income - net_personal_spend - savings) < 0.01
assert abs(gross_spend - refunds - net_personal_spend) < 0.01

# Per month in monthly_series:
for row in monthly:
    assert abs(row.income - row.spend - row.net) < 0.01

# Sankey (when built):
assert sum(link.value for link in in_links) == sum(link.value for link in out_links) ± opening_delta
```

### 7.2 Manual QA checklist

- [ ] Change date filter → every KPI, chart, table updates
- [ ] Refund credit appears in Money In but NOT in True Income
- [ ] Internal transfer excluded from spend and income
- [ ] EMI lump-sum excluded; instalments appear in correct month/category
- [ ] Balance chart first point ≠ 0 when mid-history window selected
- [ ] Expand Sankey category → subcategory sums equal parent

---

## 8. API Additions (implementation backlog)

| Endpoint | Purpose | Phase |
|----------|---------|-------|
| `GET /analytics/snapshot` | §1 KPIs: cash flow + personal economics in one payload | 1 |
| `GET /analytics/sankey` | Sankey nodes/links with optional expand path | 1 |
| `GET /analytics/expense-drilldown` | category → subcategory → counterparty | 1 |
| `GET /analytics/savings-trend` | Monthly true income, net spend, savings | 1 |
| Extend `HeadlineMetrics` | Add `total_refunds`, `true_income`, `net_personal_spend` | 1 |

Existing endpoints to reuse:

- `/headline`, `/income-detail`, `/monthly`, `/categories`, `/balance-trend`, `/net-worth`, `/counterparties`, `/categorization-progress`

---

## 9. Implementation Phases

### Phase 1 — Foundation (2–3 weeks)

- [x] Global `DateRangeProvider`; merge `/` + `/analytics`
- [x] §1 Financial Snapshot component + `/analytics/snapshot` API
- [x] Extend headline metrics via snapshot (true income, net spend, savings)
- [x] Reorder dashboard page to spec layout
- [x] `validate_analytics.py` script
- [x] Fix date filter gaps (CC recon, EMI parity)

### Phase 2 — Sankey (2–3 weeks)

- [x] `/analytics/sankey` with reconciliation tests
- [x] Sankey component (custom SVG column layout)
- [x] Single-period default; category expand on click

### Phase 3 — Drill-downs & polish (1–2 weeks)

- [x] Expense drill-down drawer (category → subcategory → counterparty → txns)
- [x] Refund sub-type taxonomy + auto-tag + drawer picker
- [x] Uncategorized review queue in §6 (date-filtered)

### Defer

| Item | Why defer |
|------|-----------|
| Multi-month Sankey chain | High complexity; validate single-period first |
| Net worth incl. CC debt | Needs liability model |
| Transfer as 4th txn type in DB | Booleans work; migrate later if needed |
| Income taxonomy normalization (`Income/Salary` vs root `Salary`) | Data migration; do before Sankey income nodes |
| Predictive / budget features | Out of scope for analytics MVP |

---

## 10. Income Taxonomy Note

Two tagging shapes coexist:

- **Taxonomy seed:** `Salary`, `Interest Income` as level-1 roots
- **Auto-tag / rules:** `category=Income`, `subcategory=Salary`

Before building Sankey income nodes, normalize to one shape (recommend: flat income roots from taxonomy, migrate legacy `Income/*` rows).

---

## References

- `backend/services/analytics_service.py` — metric definitions
- `backend/api/routes_analytics.py` — API surface
- `docs/CATEGORIZATION.md` — tagging & audit trail
- `frontend/app/analytics/page.tsx` — current analytics UI
