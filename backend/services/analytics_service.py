"""Analytics — spend, income, balances, net worth, EMI-aware.

Critical rules (mirror the spec)
--------------------------------
**Spend**:
  * include CC debits (actual purchases on the card)
  * include savings debits that are not internal transfers and not
    credit-card payments and not EMI lump-sums
  * include synthetic EMI instalments (one per month, projected from
    ``emi_records``)

**Income**:
  * include savings credits that are not internal transfers
  * exclude CC-side credits (which are payments landing on the card)

**Balance trend**:
  * end-of-day per savings account, forward-filled
  * net worth = sum across all savings accounts
"""

from __future__ import annotations

import calendar
import logging
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from typing import Dict, Iterator, List, Optional, Tuple

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from db.models import (
    ACCOUNT_TYPE_CREDIT_CARD, ACCOUNT_TYPE_SAVINGS,
    TXN_TYPE_CREDIT, TXN_TYPE_DEBIT, CCBillLink, EMIRecord, Transaction,
)
from services.emi_service import EMIInstalment, EMIService
from utils.grouping import is_usable_vpa, resolve_group_key


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# DTOs (pure dicts — easy to JSON-serialise without Pydantic gymnastics)
# ---------------------------------------------------------------------------


@dataclass
class MonthlyRow:
    period: str   # 'YYYY-MM'
    spend: float
    income: float
    net: float


@dataclass
class CategoryRow:
    category: str
    amount: float
    txn_count: int


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class AnalyticsService:
    def __init__(
        self,
        session: Session,
        date_from: Optional[date] = None,
        date_to:   Optional[date] = None,
    ) -> None:
        self.s = session
        self._date_from = date_from
        self._date_to   = date_to

    # ------------------------------------------------------------------
    # Date range helper — applied to EVERY query that reads transactions.
    # ------------------------------------------------------------------

    def _date_filter(self):
        """Conjunction of date-range predicates (empty if no range set)."""
        clauses = []
        if self._date_from:
            clauses.append(Transaction.date >= self._date_from)
        if self._date_to:
            clauses.append(Transaction.date <= self._date_to)
        return and_(*clauses) if clauses else and_(True)   # no-op when empty

    def _date_to_cap(self) -> date:
        """Upper bound for EMI instalment periods (respects active date window)."""
        return self._date_to or date.today()

    def _billing_period_in_range(self, period: str) -> bool:
        """True when ``YYYY-MM`` billing month overlaps the active date window."""
        if not self._date_from and not self._date_to:
            return True
        period = _normalize_period(period)
        first = _period_to_date(period)
        y, m = int(period[:4]), int(period[5:7])
        last = date(y, m, calendar.monthrange(y, m)[1])
        if self._date_from and last < self._date_from:
            return False
        if self._date_to and first > self._date_to:
            return False
        return True

    def _iter_emi_instalments(self) -> Iterator[Tuple[EMIInstalment, Optional[Transaction]]]:
        """Yield (instalment, original_txn) pairs inside the active date window."""
        date_to_cap = self._date_to_cap()
        for emi in self.s.scalars(select(EMIRecord)):
            t = self.s.get(Transaction, emi.original_transaction_id)
            for ins in EMIService.project_instalments(emi):
                pdate = _period_to_date(ins.period)
                if self._date_from is not None and pdate < self._date_from:
                    continue
                if pdate > date_to_cap:
                    continue
                yield ins, t

    # ------------------------------------------------------------------
    # Shared "real expense" predicate
    # ------------------------------------------------------------------

    def _not_internal_transfer(self):
        """Exclude flag OR category tag — either means "not real spend/income".

        Manual/rule tagging often sets ``category='Internal Transfer'`` without
        flipping ``is_internal_transfer``; both must keep rows out of expenses.
        """
        return and_(
            Transaction.is_internal_transfer.is_(False),
            or_(
                Transaction.category.is_(None),
                Transaction.category != "Internal Transfer",
            ),
        )

    def _is_internal_transfer(self):
        """Inverse of :meth:`_not_internal_transfer` for counts/exclusions."""
        return or_(
            Transaction.is_internal_transfer.is_(True),
            Transaction.category == "Internal Transfer",
        )

    def _real_expense_where(self):
        """SQL clause: a debit that contributes to "what I actually spent".

        Excludes:
        * internal transfers (flag or category tag)
        * credit card payments (the savings-side leg)
        * EMI lump-sums (replaced by projected instalments)
        * rows outside the date range (when a range is active)
        """
        return and_(
            Transaction.type == TXN_TYPE_DEBIT,
            self._not_internal_transfer(),
            Transaction.is_credit_card_payment.is_(False),
            Transaction.is_emi.is_(False),
            self._date_filter(),
        )

    def _refund_where(self):
        """SQL clause: a credit that should *subtract* from a spend bucket."""
        return and_(
            Transaction.type == TXN_TYPE_CREDIT,
            Transaction.is_refund.is_(True),
            self._not_internal_transfer(),
            self._date_filter(),
        )

    def _real_income_where(self):
        """SQL clause: real income — explicitly excludes refunds."""
        return and_(
            Transaction.type == TXN_TYPE_CREDIT,
            Transaction.account_type == ACCOUNT_TYPE_SAVINGS,
            self._not_internal_transfer(),
            Transaction.is_refund.is_(False),
            self._date_filter(),
        )

    # ------------------------------------------------------------------
    # Headline metrics
    # ------------------------------------------------------------------

    def _cash_in_where(self):
        """All savings credits (includes refunds) — cash-flow money in."""
        return and_(
            Transaction.type == TXN_TYPE_CREDIT,
            Transaction.account_type == ACCOUNT_TYPE_SAVINGS,
            self._not_internal_transfer(),
            self._date_filter(),
        )

    def headline(self) -> dict:
        # When a date range is active, count only in-range transactions.
        total_txns = self.s.scalar(
            select(func.count(Transaction.id)).where(self._date_filter())
        ) or 0
        spend_real = (
            self.s.scalar(select(func.coalesce(func.sum(Transaction.amount), 0.0))
                          .where(self._real_expense_where()))
            or 0.0
        )
        # Refunds reduce gross spend.
        refunds_total = (
            self.s.scalar(select(func.coalesce(func.sum(Transaction.amount), 0.0))
                          .where(self._refund_where()))
            or 0.0
        )
        income = (
            self.s.scalar(select(func.coalesce(func.sum(Transaction.amount), 0.0))
                          .where(self._real_income_where()))
            or 0.0
        )
        # EMI: only instalments whose period falls within the active window.
        emi_spend = sum(ins.amount for ins, _ in self._iter_emi_instalments())
        total_spend = float(spend_real) + float(emi_spend) - float(refunds_total)
        net = float(income) - total_spend
        savings_rate = (net / float(income) * 100.0) if income else 0.0

        date_f = self._date_filter()
        internal_count = self.s.scalar(
            select(func.count(Transaction.id))
            .where(self._is_internal_transfer(), date_f)
        ) or 0
        cc_pay_count = self.s.scalar(
            select(func.count(Transaction.id))
            .where(Transaction.is_credit_card_payment.is_(True), date_f)
        ) or 0
        emi_count = self.s.scalar(
            select(func.count(Transaction.id))
            .where(Transaction.is_emi.is_(True), date_f)
        ) or 0

        return {
            "total_txns":           int(total_txns),
            "total_spend":          round(total_spend, 2),
            "total_income":         round(float(income), 2),
            "net":                  round(net, 2),
            "savings_rate_pct":     round(savings_rate, 2),
            "spend_excluding_emi":  round(float(spend_real), 2),
            "spend_from_emi":       round(float(emi_spend), 2),
            "internal_transfers":   int(internal_count),
            "credit_card_payments": int(cc_pay_count),
            "emi_transactions":     int(emi_count),
        }

    def financial_snapshot(self) -> dict:
        """§1 payload: cash flow vs true personal economics."""
        spend_real = (
            self.s.scalar(select(func.coalesce(func.sum(Transaction.amount), 0.0))
                          .where(self._real_expense_where()))
            or 0.0
        )
        refunds_total = (
            self.s.scalar(select(func.coalesce(func.sum(Transaction.amount), 0.0))
                          .where(self._refund_where()))
            or 0.0
        )
        true_income = (
            self.s.scalar(select(func.coalesce(func.sum(Transaction.amount), 0.0))
                          .where(self._real_income_where()))
            or 0.0
        )
        money_in = (
            self.s.scalar(select(func.coalesce(func.sum(Transaction.amount), 0.0))
                          .where(self._cash_in_where()))
            or 0.0
        )
        emi_spend = sum(ins.amount for ins, _ in self._iter_emi_instalments())
        gross_expenses = float(spend_real) + float(emi_spend)
        net_personal_spend = gross_expenses - float(refunds_total)
        savings = float(true_income) - net_personal_spend
        savings_rate = (savings / float(true_income) * 100.0) if true_income else 0.0
        net_cash_flow = float(money_in) - gross_expenses

        head = self.headline()
        income_detail = self.income_detail()
        monthly_averages = self._monthly_averages()

        return {
            "total_txns": head["total_txns"],
            "cash_flow": {
                "money_in":  round(float(money_in), 2),
                "money_out": round(gross_expenses, 2),
                "net":       round(net_cash_flow, 2),
            },
            "personal_economics": {
                "true_income":          round(float(true_income), 2),
                "income_by_source":     income_detail["by_subcategory"],
                "refunds_recoveries":   round(float(refunds_total), 2),
                "gross_expenses":       round(gross_expenses, 2),
                "refunds_applied":      round(float(refunds_total), 2),
                "net_personal_spend":   round(net_personal_spend, 2),
                "savings":              round(savings, 2),
                "savings_rate_pct":     round(savings_rate, 2),
            },
            "monthly_averages": monthly_averages,
            "excluded": {
                "internal_transfers":   head["internal_transfers"],
                "credit_card_payments": head["credit_card_payments"],
                "emi_transactions":     head["emi_transactions"],
            },
        }

    def _monthly_averages(self) -> dict:
        """Avg income / spend / saving across months in the active window."""
        rows = self.monthly_series()
        n = len(rows)
        if n == 0:
            return {
                "months": 0,
                "avg_income": 0.0,
                "avg_spend": 0.0,
                "avg_saving": 0.0,
                "avg_saving_rate_pct": 0.0,
            }
        avg_income = sum(r.income for r in rows) / n
        avg_spend = sum(r.spend for r in rows) / n
        avg_saving = sum(r.net for r in rows) / n
        avg_rate = (avg_saving / avg_income * 100.0) if avg_income else 0.0
        return {
            "months": n,
            "avg_income": round(avg_income, 2),
            "avg_spend": round(avg_spend, 2),
            "avg_saving": round(avg_saving, 2),
            "avg_saving_rate_pct": round(avg_rate, 2),
        }

    # ------------------------------------------------------------------
    # Monthly spend & income
    # ------------------------------------------------------------------

    def monthly_series(self) -> List[MonthlyRow]:
        # 1. Real (non-EMI) spend
        spend_rows = self.s.execute(
            select(
                func.strftime("%Y-%m", Transaction.date).label("period"),
                func.coalesce(func.sum(Transaction.amount), 0.0),
            )
            .where(self._real_expense_where())
            .group_by("period")
        ).all()
        spend_map: Dict[str, float] = {p: float(v) for p, v in spend_rows}

        # 2. Income
        income_rows = self.s.execute(
            select(
                func.strftime("%Y-%m", Transaction.date).label("period"),
                func.coalesce(func.sum(Transaction.amount), 0.0),
            )
            .where(self._real_income_where())
            .group_by("period")
        ).all()
        income_map: Dict[str, float] = {p: float(v) for p, v in income_rows}

        # 3. Refunds — subtract from the month they landed in.
        refund_rows = self.s.execute(
            select(
                func.strftime("%Y-%m", Transaction.date).label("period"),
                func.coalesce(func.sum(Transaction.amount), 0.0),
            )
            .where(self._refund_where())
            .group_by("period")
        ).all()
        for p, v in refund_rows:
            spend_map[p] = spend_map.get(p, 0.0) - float(v)

        # 4. EMI instalments — fold into spend (date-window aware).
        for ins, _ in self._iter_emi_instalments():
            spend_map[ins.period] = spend_map.get(ins.period, 0.0) + ins.amount

        periods = sorted(set(spend_map) | set(income_map))
        return [
            MonthlyRow(
                period=p,
                spend=round(spend_map.get(p, 0.0), 2),
                income=round(income_map.get(p, 0.0), 2),
                net=round(income_map.get(p, 0.0) - spend_map.get(p, 0.0), 2),
            )
            for p in periods
        ]

    # ------------------------------------------------------------------
    # Category breakdown
    # ------------------------------------------------------------------

    def category_breakdown(self) -> List[CategoryRow]:
        rows = self.s.execute(
            select(
                func.coalesce(Transaction.category, "Uncategorized"),
                func.sum(Transaction.amount),
                func.count(Transaction.id),
            )
            .where(self._real_expense_where())
            .group_by(func.coalesce(Transaction.category, "Uncategorized"))
        ).all()

        # Fold EMI projections by the *original transaction's* category
        # so an EMI'd flight ride still counts as "Travel" in monthly
        # buckets even though the lump-sum row is excluded.
        emi_by_cat: Dict[str, float] = defaultdict(float)
        emi_cnt: Dict[str, int] = defaultdict(int)
        for ins, t in self._iter_emi_instalments():
            cat = (t.category if t and t.category else "Uncategorized")
            emi_by_cat[cat] += ins.amount
            emi_cnt[cat] += 1

        agg: Dict[str, list] = {}
        for cat, amt, n in rows:
            agg[cat] = [float(amt or 0.0), int(n or 0)]
        for cat, amt in emi_by_cat.items():
            cur = agg.get(cat, [0.0, 0])
            cur[0] += amt
            cur[1] += emi_cnt[cat]
            agg[cat] = cur

        # Refund-aware subtraction. Use ``refund_category`` if set,
        # fall back to ``category`` otherwise. Don't touch txn_count —
        # the user still made one transaction whose net effect is zero.
        refund_rows = self.s.execute(
            select(
                func.coalesce(Transaction.refund_category, Transaction.category, "Uncategorized"),
                func.sum(Transaction.amount),
            )
            .where(self._refund_where())
            .group_by(func.coalesce(Transaction.refund_category, Transaction.category, "Uncategorized"))
        ).all()
        for cat, amt in refund_rows:
            cur = agg.get(cat, [0.0, 0])
            cur[0] -= float(amt or 0.0)
            agg[cat] = cur

        out = [
            CategoryRow(category=cat, amount=round(v[0], 2), txn_count=int(v[1]))
            for cat, v in agg.items()
        ]
        out.sort(key=lambda r: r.amount, reverse=True)
        return out

    # ------------------------------------------------------------------
    # Income breakdown (Salary vs Interest vs Dividends vs Pocket Money…)
    # ------------------------------------------------------------------

    def income_breakdown(self) -> List[dict]:
        """Real income grouped by (category, subcategory).

        Refund credits are explicitly excluded (see ``_real_income_where``)
        so a personal payback never appears as a salary-line.

        We group by *both* category and subcategory so the UI can render
        rows like "Income / Salary" — and users who introduce a custom
        income root (e.g. "Side Hustle") see it broken out too.
        """
        rows = self.s.execute(
            select(
                func.coalesce(Transaction.category, "Uncategorized"),
                Transaction.subcategory,
                func.sum(Transaction.amount),
                func.count(Transaction.id),
            )
            .where(self._real_income_where())
            .group_by(
                func.coalesce(Transaction.category, "Uncategorized"),
                Transaction.subcategory,
            )
            .order_by(func.sum(Transaction.amount).desc())
        ).all()
        return [
            {
                "category":    cat,
                "subcategory": sub,
                "amount":      round(float(amt or 0.0), 2),
                "txn_count":   int(n),
            }
            for cat, sub, amt, n in rows
        ]

    # ------------------------------------------------------------------
    # Rich income dashboard — totals + subcategory breakdown +
    # separate-refunds card + monthly trend.
    # ------------------------------------------------------------------

    def income_detail(self) -> dict:
        """Full payload for the rebuilt income dashboard.

        Refunds are intentionally NOT folded into income — they're
        returned in their own bucket so the UI can render them as a
        distinct card ("Refunds: ₹X by category"). Credits whose
        subcategory is null collapse into "Uncategorized Income" so the
        sum is honest.
        """
        # 1. Subcategory totals — drop the redundant top-level category
        # because everything in `_real_income_where` already lives under
        # an "Income" root in practice.
        sub_rows = self.s.execute(
            select(
                Transaction.subcategory,
                func.sum(Transaction.amount),
                func.count(Transaction.id),
            )
            .where(self._real_income_where())
            .group_by(Transaction.subcategory)
            .order_by(func.sum(Transaction.amount).desc())
        ).all()
        by_sub: List[dict] = []
        total_income = 0.0
        for sub, amt, n in sub_rows:
            label = sub or "Uncategorized Income"
            v = float(amt or 0.0)
            total_income += v
            by_sub.append({
                "subcategory": label,
                "amount":      round(v, 2),
                "txn_count":   int(n),
            })

        # 2. Refunds — keyed by the spend bucket they offset, not by
        # income subcategory. Credits with refund_category IS NULL fall
        # into "Uncategorized" (and the user can fix them from the UI).
        refund_rows = self.s.execute(
            select(
                func.coalesce(Transaction.refund_category, "Uncategorized"),
                func.sum(Transaction.amount),
                func.count(Transaction.id),
            )
            .where(self._refund_where())
            .group_by(func.coalesce(Transaction.refund_category, "Uncategorized"))
            .order_by(func.sum(Transaction.amount).desc())
        ).all()
        refunds_total = 0.0
        refunds_by_cat: List[dict] = []
        for cat, amt, n in refund_rows:
            v = float(amt or 0.0)
            refunds_total += v
            refunds_by_cat.append({
                "category":  cat,
                "amount":    round(v, 2),
                "txn_count": int(n),
            })

        # 2b. Refund sub-types (subcategory on refund credits).
        type_rows = self.s.execute(
            select(
                func.coalesce(Transaction.subcategory, "Uncategorized"),
                func.sum(Transaction.amount),
                func.count(Transaction.id),
            )
            .where(self._refund_where())
            .group_by(func.coalesce(Transaction.subcategory, "Uncategorized"))
            .order_by(func.sum(Transaction.amount).desc())
        ).all()
        refunds_by_type: List[dict] = [
            {
                "refund_type": rt or "Uncategorized",
                "amount":      round(float(amt or 0.0), 2),
                "txn_count":   int(n),
            }
            for rt, amt, n in type_rows
        ]

        # 3. Monthly trend — one point per (period, subcategory) so the
        # frontend can plot stacked bars without re-aggregating.
        monthly_rows = self.s.execute(
            select(
                func.strftime("%Y-%m", Transaction.date).label("period"),
                Transaction.subcategory,
                func.sum(Transaction.amount),
            )
            .where(self._real_income_where())
            .group_by("period", Transaction.subcategory)
            .order_by("period")
        ).all()
        monthly: List[dict] = [
            {
                "period":      p,
                "subcategory": sub or "Uncategorized Income",
                "amount":      round(float(amt or 0.0), 2),
            }
            for p, sub, amt in monthly_rows
        ]

        return {
            "total_income":         round(total_income, 2),
            "total_refunds":        round(refunds_total, 2),
            "by_subcategory":       by_sub,
            "refunds_by_category":  refunds_by_cat,
            "refunds_by_type":      refunds_by_type,
            "monthly_trend":        monthly,
        }

    # ------------------------------------------------------------------
    # Monthly category cells — powers the stacked-bar "top-5 over time".
    # ------------------------------------------------------------------

    def monthly_by_category(self, top_n: int = 5) -> List[dict]:
        """Return ``[{period, category, amount, pct_of_month}, …]``.

        When ``top_n`` is large (≥ 50) every category is kept. Otherwise
        only the top-N by total spend are named and the rest roll into
        ``Other``. Refund-aware. Used for monthly category tables/charts.
        """
        # 1. Pick top-N categories by total spend (include EMI projections).
        cat_rows = self.s.execute(
            select(
                func.coalesce(Transaction.category, "Uncategorized"),
                func.sum(Transaction.amount),
            )
            .where(self._real_expense_where())
            .group_by(func.coalesce(Transaction.category, "Uncategorized"))
            .order_by(func.sum(Transaction.amount).desc())
        ).all()
        cat_totals: Dict[str, float] = {c: float(v or 0.0) for c, v in cat_rows}
        for ins, t in self._iter_emi_instalments():
            cat = (t.category if t and t.category else "Uncategorized")
            cat_totals[cat] = cat_totals.get(cat, 0.0) + ins.amount
        keep_all = top_n >= 50
        top_cats = (
            set(cat_totals)
            if keep_all
            else {
                c for c, _ in sorted(cat_totals.items(), key=lambda x: x[1], reverse=True)[:top_n]
            }
        )

        # 2. Monthly breakdown for ALL categories.
        per_month = self.s.execute(
            select(
                func.strftime("%Y-%m", Transaction.date).label("period"),
                func.coalesce(Transaction.category, "Uncategorized"),
                func.sum(Transaction.amount),
            )
            .where(self._real_expense_where())
            .group_by("period", func.coalesce(Transaction.category, "Uncategorized"))
        ).all()

        # 3. Subtract refunds per (period, refund_category).
        refunds = self.s.execute(
            select(
                func.strftime("%Y-%m", Transaction.date).label("period"),
                func.coalesce(Transaction.refund_category, Transaction.category, "Uncategorized"),
                func.sum(Transaction.amount),
            )
            .where(self._refund_where())
            .group_by("period",
                      func.coalesce(Transaction.refund_category, Transaction.category, "Uncategorized"))
        ).all()

        agg: Dict[tuple, float] = defaultdict(float)
        for period, cat, amt in per_month:
            agg[(period, cat)] += float(amt or 0.0)
        for ins, t in self._iter_emi_instalments():
            cat = (t.category if t and t.category else "Uncategorized")
            agg[(ins.period, cat)] += ins.amount
        for period, cat, amt in refunds:
            agg[(period, cat)] -= float(amt or 0.0)

        out: List[dict] = []
        other_per_period: Dict[str, float] = defaultdict(float)
        for (period, cat), amt in agg.items():
            if cat in top_cats:
                out.append({"period": period, "category": cat, "amount": round(amt, 2)})
            else:
                other_per_period[period] += amt
        for period, amt in other_per_period.items():
            if abs(amt) > 0.005:
                out.append({"period": period, "category": "Other", "amount": round(amt, 2)})

        month_totals: Dict[str, float] = defaultdict(float)
        for row in out:
            month_totals[row["period"]] += row["amount"]
        for row in out:
            total = month_totals.get(row["period"], 0.0)
            row["pct_of_month"] = round((row["amount"] / total * 100.0) if total else 0.0, 2)

        out.sort(key=lambda r: (r["period"], -abs(r["amount"]), r["category"]))
        return out

    # ------------------------------------------------------------------
    # Balance trend
    # ------------------------------------------------------------------

    def balance_trend(self) -> List[dict]:
        """End-of-day balance per savings account.

        Returns a list of ``{date, account_name, balance}`` rows the
        frontend can pivot into a line chart.

        The active date range (when set) clips the output but the
        balance values are computed from the *full* history — so the
        first point inside the window carries the real running balance
        rather than restarting from zero.
        """
        rows = self.s.execute(
            select(
                Transaction.date,
                Transaction.account_name,
                Transaction.balance,
                Transaction.created_at,
            )
            .where(
                Transaction.account_type == ACCOUNT_TYPE_SAVINGS,
                Transaction.balance.is_not(None),
            )
            .order_by(Transaction.account_name, Transaction.date, Transaction.created_at)
        ).all()
        if not rows:
            return []

        # Keep last balance per (account, date).
        last_per_day: Dict[tuple, float] = {}
        for d, an, bal, _ in rows:
            last_per_day[(an, d)] = float(bal)

        out: List[dict] = []
        for (an, d), bal in sorted(last_per_day.items(), key=lambda x: (x[0][0], x[0][1])):
            if self._date_from and d < self._date_from:
                continue
            if self._date_to and d > self._date_to:
                continue
            out.append({"date": d.isoformat(), "account_name": an, "balance": bal})
        return out

    def net_worth_series(self) -> List[dict]:
        """Daily sum of latest-known balance across savings accounts.

        We always forward-fill from the *full* history so the first point
        inside the active window already reflects every prior transaction.
        Then we clip to the window for display.
        """
        # Compute on the full history first so forward-fill is correct.
        full = AnalyticsService(self.s).balance_trend()  # no date range
        if not full:
            return []
        accounts: List[str] = sorted({row["account_name"] for row in full})
        by_date: Dict[str, Dict[str, float]] = defaultdict(dict)
        for row in full:
            by_date[row["date"]][row["account_name"]] = row["balance"]

        all_dates = sorted(by_date.keys())
        # An account whose first transaction comes later than the series
        # start still had money before it: its opening balance is the first
        # day's closing balance minus that day's net movement. Without this
        # the series shows a fake jump on the account's first transaction.
        opening = self._opening_balances(accounts, by_date)
        running: Dict[str, float] = {a: opening.get(a, 0.0) for a in accounts}
        seen: Dict[str, bool] = {a: a in opening for a in accounts}
        out: List[dict] = []
        for d in all_dates:
            for a in accounts:
                if a in by_date[d]:
                    running[a] = by_date[d][a]
                    seen[a] = True
            if self._date_from and d < self._date_from.isoformat():
                continue
            if self._date_to and d > self._date_to.isoformat():
                continue
            nw = sum(running[a] for a in accounts if seen[a])
            out.append({"date": d, "net_worth": round(nw, 2)})
        return out

    def _opening_balances(self, accounts: List[str], by_date: Dict[str, Dict[str, float]]) -> Dict[str, float]:
        out: Dict[str, float] = {}
        for a in accounts:
            first = next((d for d in sorted(by_date) if a in by_date[d]), None)
            if first is None:
                continue
            rows = self.s.execute(
                select(Transaction.amount, Transaction.type).where(
                    Transaction.account_name == a,
                    Transaction.date == date.fromisoformat(first) if isinstance(first, str) else Transaction.date == first,
                )
            ).all()
            net = sum(float(amt) if str(typ).lower() == "credit" else -float(amt) for amt, typ in rows)
            out[a] = by_date[first][a] - net
        return out

    # ------------------------------------------------------------------
    # Top counterparties
    # ------------------------------------------------------------------

    def top_counterparties(self, limit: int = 20) -> List[dict]:
        rows = self.s.execute(
            select(
                func.coalesce(Transaction.merchant_name, Transaction.vpa, "(unknown)").label("cp"),
                func.sum(Transaction.amount),
                func.count(Transaction.id),
            )
            .where(self._real_expense_where())
            .group_by("cp")
            .order_by(func.sum(Transaction.amount).desc())
            .limit(limit)
        ).all()
        return [
            {"counterparty": cp, "amount": round(float(amt or 0), 2), "txn_count": int(n)}
            for cp, amt, n in rows
        ]

    # ------------------------------------------------------------------
    # VPA / merchant summary — used by the Categorize page top-panel.
    # ------------------------------------------------------------------

    def counterparty_summary(
        self,
        vpa: Optional[str] = None,
        merchant_name: Optional[str] = None,
    ) -> dict:
        """Headline credit / debit / net for a single VPA or merchant.

        Excludes internal transfers + CC bill payments + EMI lump-sums
        so the user sees the *real* economic flow with this counterparty
        (which is what they care about when deciding what to categorise).
        """
        if not vpa and not merchant_name:
            return {
                "label": "", "kind": "", "total_credit": 0.0, "total_debit": 0.0,
                "net": 0.0, "transaction_count": 0,
                "first_date": None, "last_date": None,
            }

        if vpa:
            label, kind = vpa, "vpa"
            where_clause = func.lower(Transaction.vpa) == vpa.lower()
        else:
            label, kind = merchant_name or "", "merchant"
            where_clause = func.lower(Transaction.merchant_name) == (merchant_name or "").lower()

        # Same exclusions as the analytics views so the panel and the
        # dashboard agree.
        clean = and_(
            where_clause,
            self._not_internal_transfer(),
            Transaction.is_credit_card_payment.is_(False),
            Transaction.is_emi.is_(False),
        )

        credit = self.s.scalar(
            select(func.coalesce(func.sum(Transaction.amount), 0.0))
            .where(clean, Transaction.type == TXN_TYPE_CREDIT)
        ) or 0.0
        debit = self.s.scalar(
            select(func.coalesce(func.sum(Transaction.amount), 0.0))
            .where(clean, Transaction.type == TXN_TYPE_DEBIT)
        ) or 0.0
        count = self.s.scalar(
            select(func.count(Transaction.id)).where(clean)
        ) or 0
        first_d = self.s.scalar(select(func.min(Transaction.date)).where(clean))
        last_d  = self.s.scalar(select(func.max(Transaction.date)).where(clean))

        credit = float(credit)
        debit  = float(debit)
        return {
            "label":             label,
            "kind":              kind,
            "total_credit":      round(credit, 2),
            "total_debit":       round(debit, 2),
            "net":               round(credit - debit, 2),
            "transaction_count": int(count),
            "first_date":        first_d.isoformat() if first_d else None,
            "last_date":         last_d.isoformat() if last_d else None,
        }

    # ------------------------------------------------------------------
    # CC bill reconciliation — month-by-month spend on a CC vs payment
    # ------------------------------------------------------------------

    def cc_reconciliation(self) -> List[dict]:
        """Monthly CC-spend / amount-paid / difference for every CC account.

        Spend = sum of CC-side debits per (account, month).
        Paid  = sum of cc_bill_links.total_amount per (account, billing_month).
        """
        # Spend per (cc_account, month)
        date_f = self._date_filter()
        spend_rows = self.s.execute(
            select(
                Transaction.account_name,
                func.strftime("%Y-%m", Transaction.date).label("period"),
                func.sum(Transaction.amount),
                func.count(Transaction.id),
            )
            .where(
                Transaction.account_type == ACCOUNT_TYPE_CREDIT_CARD,
                Transaction.type == TXN_TYPE_DEBIT,
                date_f,
            )
            .group_by(Transaction.account_name, "period")
        ).all()

        # Paid per (cc_account, month) — from explicit user mappings.
        paid_rows = self.s.execute(
            select(
                CCBillLink.cc_account_name,
                CCBillLink.billing_month,
                func.sum(CCBillLink.total_amount),
            ).group_by(CCBillLink.cc_account_name, CCBillLink.billing_month)
        ).all()
        paid_map: Dict[tuple, float] = {}
        for an, period, amt in paid_rows:
            if not self._billing_period_in_range(period):
                continue
            paid_map[(an, period)] = paid_map.get((an, period), 0.0) + float(amt or 0.0)

        out: List[dict] = []
        for an, period, amt, n in spend_rows:
            if not self._billing_period_in_range(period):
                continue
            spend = float(amt or 0.0)
            paid  = paid_map.pop((an, period), 0.0)
            out.append({
                "cc_account_name": an,
                "billing_month":   period,
                "spend":           round(spend, 2),
                "paid":            round(paid, 2),
                "difference":      round(spend - paid, 2),
                "txn_count":       int(n or 0),
                "paid_known":      paid > 0,
            })
        # Capture months where the user mapped a payment but we have no
        # CC-side rows (e.g. they uploaded the savings statement but
        # not the matching CC statement yet).
        for (an, period), paid in paid_map.items():
            out.append({
                "cc_account_name": an,
                "billing_month":   period,
                "spend":           0.0,
                "paid":            round(paid, 2),
                "difference":      round(-paid, 2),
                "txn_count":       0,
                "paid_known":      True,
            })
        out.sort(key=lambda r: (r["billing_month"], r["cc_account_name"]), reverse=True)
        return out

    # ------------------------------------------------------------------
    # Money-flow Sankey (§2) + expense drill-down (§5)
    # ------------------------------------------------------------------

    def _boundary_net_worth(self) -> tuple[float, float]:
        """Opening and closing net worth for the active date window."""
        series = self.net_worth_series()
        if not series:
            return 0.0, 0.0
        return float(series[0]["net_worth"]), float(series[-1]["net_worth"])

    def _expense_net_buckets(
        self,
        *,
        category: Optional[str] = None,
        subcategory: Optional[str] = None,
    ) -> Dict[str, float]:
        """Refund-aware spend keyed by subcategory, counterparty, or category."""
        if subcategory and category:
            group_col = func.coalesce(
                Transaction.merchant_name, Transaction.vpa, "(unknown)"
            )
            filter_extra = and_(
                func.coalesce(Transaction.category, "Uncategorized") == category,
                func.coalesce(Transaction.subcategory, "Uncategorized") == subcategory,
            )
        elif category:
            group_col = func.coalesce(Transaction.subcategory, "Uncategorized")
            filter_extra = func.coalesce(Transaction.category, "Uncategorized") == category
        else:
            group_col = func.coalesce(Transaction.category, "Uncategorized")
            filter_extra = and_(True)

        rows = self.s.execute(
            select(group_col, func.sum(Transaction.amount))
            .where(self._real_expense_where(), filter_extra)
            .group_by(group_col)
        ).all()
        agg: Dict[str, float] = {str(k): float(v or 0.0) for k, v in rows}

        # EMI folded into same bucket keys as parent transaction.
        for ins, t in self._iter_emi_instalments():
            if category and (t.category or "Uncategorized") != category:
                continue
            if subcategory and category and (t.subcategory or "Uncategorized") != subcategory:
                continue
            if subcategory and category:
                key = t.merchant_name or t.vpa or "(unknown)"
            elif category:
                key = t.subcategory or "Uncategorized"
            else:
                key = t.category or "Uncategorized"
            agg[str(key)] = agg.get(str(key), 0.0) + ins.amount

        # Refund offsets — mirror grouping dimension.
        if subcategory and category:
            refund_group = func.coalesce(
                Transaction.merchant_name, Transaction.vpa, "(unknown)"
            )
            refund_filter = and_(
                func.coalesce(Transaction.refund_category, Transaction.category, "Uncategorized") == category,
            )
        elif category:
            refund_group = func.coalesce(Transaction.refund_category, Transaction.category, "Uncategorized")
            refund_filter = func.coalesce(Transaction.refund_category, Transaction.category, "Uncategorized") == category
        else:
            refund_group = func.coalesce(Transaction.refund_category, Transaction.category, "Uncategorized")
            refund_filter = and_(True)

        refund_rows = self.s.execute(
            select(refund_group, func.sum(Transaction.amount))
            .where(self._refund_where(), refund_filter)
            .group_by(refund_group)
        ).all()
        for k, v in refund_rows:
            agg[str(k)] = agg.get(str(k), 0.0) - float(v or 0.0)

        return {k: round(v, 2) for k, v in agg.items() if abs(v) > 0.005}

    def sankey(
        self,
        mode: str = "period",
        expanded: Optional[List[str]] = None,
        top_n: int = 8,
        expand: Optional[str] = None,
    ) -> dict:
        """Build money-flow Sankey (delegates to SankeyService).

        ``expand`` legacy param: slash path → converted to last segment id.
        Prefer ``expanded`` as comma-separated node ids.
        """
        from services.sankey_service import SankeyService

        expanded_ids: List[str] = list(expanded or [])
        if expand and not expanded_ids:
            parts = [p.strip() for p in expand.split("/") if p.strip()]
            if parts:
                cat = parts[0]
                expanded_ids = [f"expense:{_legacy_slug(cat)}"]
                if len(parts) >= 2:
                    expanded_ids.append(
                        f"expense:{_legacy_slug(cat)}:{_legacy_slug(parts[1])}"
                    )

        return SankeyService(self).build(
            mode=mode, expanded=expanded_ids, top_n=top_n,
        )

    def expense_drilldown(
        self,
        category: str,
        subcategory: Optional[str] = None,
        counterparty: Optional[str] = None,
        limit: int = 50,
    ) -> dict:
        """Category → subcategory → counterparty → transactions."""
        from db.models import Transaction as Txn

        if counterparty and subcategory:
            cp_filter = and_(
                func.coalesce(Txn.category, "Uncategorized") == category,
                func.coalesce(Txn.subcategory, "Uncategorized") == subcategory,
                func.coalesce(Txn.merchant_name, Txn.vpa, "(unknown)") == counterparty,
                Txn.type == TXN_TYPE_DEBIT,
                self._not_internal_transfer(),
                Txn.is_credit_card_payment.is_(False),
                Txn.is_emi.is_(False),
                self._date_filter(),
            )
            rows = list(self.s.scalars(
                select(Txn).where(cp_filter).order_by(Txn.amount.desc()).limit(limit)
            ))
            total = sum(t.amount for t in rows)
            return {
                "level": "transactions",
                "category": category,
                "subcategory": subcategory,
                "counterparty": counterparty,
                "total": round(total, 2),
                "rows": [
                    {
                        "id": t.id,
                        "label": (t.description or "")[:80],
                        "date": t.date.isoformat() if t.date else None,
                        "amount": round(t.amount, 2),
                        "txn_count": 1,
                    }
                    for t in rows
                ],
            }

        if subcategory:
            buckets = self._expense_net_buckets(category=category, subcategory=subcategory)
            rows = [
                {"label": k, "amount": v, "txn_count": 0}
                for k, v in sorted(buckets.items(), key=lambda x: -x[1])
            ]
            return {
                "level": "counterparty",
                "category": category,
                "subcategory": subcategory,
                "total": round(sum(buckets.values()), 2),
                "rows": rows,
            }

        buckets = self._expense_net_buckets(category=category)
        rows = [
            {"label": k, "amount": v, "txn_count": 0}
            for k, v in sorted(buckets.items(), key=lambda x: -x[1])
        ]
        return {
            "level": "subcategory",
            "category": category,
            "subcategory": None,
            "total": round(sum(buckets.values()), 2),
            "rows": rows,
        }

    def review_queues(self, limit: int = 15) -> dict:
        """Uncategorized review queues scoped to the active date window."""
        from utils.tagging import is_category_tagged

        flow = and_(
            self._not_internal_transfer(),
            Transaction.is_credit_card_payment.is_(False),
            Transaction.is_emi.is_(False),
            self._date_filter(),
        )
        rows = [
            t for t in self.s.scalars(select(Transaction).where(flow))
            if not is_category_tagged(t.category)
        ]

        def _agg(key_fn, label_fn):
            m: Dict[str, Dict] = defaultdict(lambda: {"amount": 0.0, "count": 0, "label": ""})
            for t in rows:
                k = key_fn(t)
                if not k:
                    continue
                m[k]["amount"] += t.amount
                m[k]["count"] += 1
                m[k]["label"] = label_fn(t)
            items = sorted(m.values(), key=lambda x: -x["amount"])[:limit]
            return [
                {"label": i["label"], "amount": round(i["amount"], 2), "txn_count": i["count"]}
                for i in items
            ]

        return {
            "top_vpas": _agg(
                lambda t: (t.vpa or "").lower() if is_usable_vpa(t.vpa) else "",
                lambda t: t.vpa or "",
            ),
            "top_counterparties": _agg(
                lambda t: (t.merchant_name or "").lower(),
                lambda t: t.merchant_name or "",
            ),
            "top_descriptions": _agg(
                lambda t: (t.description or "")[:80].lower(),
                lambda t: (t.description or "")[:80],
            ),
        }

    # ------------------------------------------------------------------
    # Categorization-progress meters (for the Categorize page header)
    # ------------------------------------------------------------------

    def categorization_progress(self) -> dict:
        """Coverage metrics for the Categorize tab — see docs/CATEGORIZATION.md."""
        from db.models import Transaction as Txn

        flow = and_(
            self._not_internal_transfer(),
            Txn.is_credit_card_payment.is_(False),
            Txn.is_emi.is_(False),
            self._date_filter(),
        )

        rows = list(self.s.scalars(select(Txn).where(flow)))

        total = len(rows)
        cat_n = sum(1 for t in rows if self._is_tagged(t.category))
        uncat_n = total - cat_n
        coverage_pct = round(100.0 * cat_n / total, 1) if total else 100.0

        # Group-level stats (same keys as /counterparties)
        vpa_groups: dict[str, dict] = {}
        mch_groups: dict[str, dict] = {}
        for t in rows:
            kind, key, label = resolve_group_key(t.vpa, t.merchant_name)
            tagged = self._is_tagged(t.category)
            bucket = vpa_groups if kind == "vpa" else mch_groups if kind == "merchant" else None
            if bucket is None:
                continue
            g = bucket.setdefault(label, {"n": 0, "uncat": 0})
            g["n"] += 1
            if not tagged:
                g["uncat"] += 1

        def _group_counts(groups: dict) -> tuple[int, int, int]:
            total_g = len(groups)
            uncat_g = sum(1 for g in groups.values() if g["uncat"] > 0)
            return total_g, total_g - uncat_g, uncat_g

        total_vpas, cat_vpas, uncat_vpas = _group_counts(vpa_groups)
        total_cp, cat_cp, uncat_cp = _group_counts(mch_groups)
        uncat_vpa_pct = round(100.0 * uncat_vpas / total_vpas, 1) if total_vpas else 0.0

        # Financial impact
        uncat_expense = sum(
            t.amount for t in rows
            if t.type == TXN_TYPE_DEBIT and not self._is_tagged(t.category)
        )
        uncat_income = sum(
            t.amount for t in rows
            if t.type == TXN_TYPE_CREDIT and not self._is_tagged(t.category)
        )
        total_expense = sum(t.amount for t in rows if t.type == TXN_TYPE_DEBIT)
        uncat_expense_pct = round(100.0 * uncat_expense / total_expense, 1) if total_expense else 0.0

        no_vpa = sum(1 for t in rows if not is_usable_vpa(t.vpa))

        return {
            "total_transactions": total,
            "categorized_transactions": cat_n,
            "uncategorized_transactions": uncat_n,
            "coverage_pct": coverage_pct,
            "total_vpas": total_vpas,
            "categorized_vpas": cat_vpas,
            "uncategorized_vpas": uncat_vpas,
            "uncat_vpa_pct": uncat_vpa_pct,
            "total_counterparties": total_cp,
            "categorized_counterparties": cat_cp,
            "uncategorized_counterparties": uncat_cp,
            "uncat_expense_amount": round(uncat_expense, 2),
            "uncat_income_amount": round(uncat_income, 2),
            "uncat_net_amount": round(uncat_income - uncat_expense, 2),
            "total_expense_amount": round(total_expense, 2),
            "uncat_expense_pct": uncat_expense_pct,
            "uncategorized_txns": uncat_n,
            "transactions_no_vpa": no_vpa,
        }

    @staticmethod
    def _is_tagged(category: Optional[str]) -> bool:
        return bool((category or "").strip())


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _legacy_slug(label: str) -> str:
    import re
    s = re.sub(r"[^a-zA-Z0-9]+", "-", label.strip()).strip("-").lower()
    return s or "item"


def _normalize_period(period: str) -> str:
    """``YYYY-MM`` or ``YYYY-MM-DD`` → ``YYYY-MM``."""
    return period[:7] if period else period


def _period_to_date(period: str) -> date:
    """``'YYYY-MM'`` → first-of-month ``date``. Used to compare with today()."""
    p = _normalize_period(period)
    y, m = p.split("-")
    return date(int(y), int(m), 1)
