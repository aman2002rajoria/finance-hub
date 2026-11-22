"""Money-flow Sankey — period summary + monthly timeline with hierarchical expansion.

Savings definition (documented):
    period_savings = closing_balance − opening_balance
    i.e. the change in net worth over the window (retained / lost wealth).

Reconciliation (each period / month):
    opening + cash_in − cash_out = closing
    where cash_in = true_income + refunds_recoveries (all savings credits),
    cash_out = net_personal_spend (refund-adjusted expenses).
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Dict, List, Optional, Set, Tuple

from services.analytics_service import AnalyticsService, _normalize_period, _period_to_date


@dataclass
class _Graph:
    nodes: List[dict] = field(default_factory=list)
    links: List[dict] = field(default_factory=list)
    _seen: Set[str] = field(default_factory=set)

    def node(
        self,
        nid: str,
        label: str,
        layer: int,
        amount: float,
        *,
        parent_id: Optional[str] = None,
        depth: int = 0,
        expandable: bool = False,
        expanded: bool = False,
        period: Optional[str] = None,
        node_type: str = "generic",
    ) -> None:
        if nid in self._seen:
            return
        self._seen.add(nid)
        self.nodes.append({
            "id": nid,
            "label": label,
            "layer": layer,
            "amount": round(amount, 2),
            "parent_id": parent_id,
            "depth": depth,
            "expandable": expandable,
            "expanded": expanded,
            "period": period,
            "node_type": node_type,
        })

    def link(
        self,
        source: str,
        target: str,
        value: float,
        *,
        link_type: str = "flow",
        balance_amount: Optional[float] = None,
        period_from: Optional[str] = None,
        period_to: Optional[str] = None,
    ) -> None:
        if value > 0.005:
            entry: dict = {
                "source": source,
                "target": target,
                "value": round(value, 2),
                "link_type": link_type,
            }
            if balance_amount is not None:
                entry["balance_amount"] = round(balance_amount, 2)
            if period_from:
                entry["period_from"] = period_from
            if period_to:
                entry["period_to"] = period_to
            self.links.append(entry)


class SankeyService:
    """Builds Sankey graphs on top of AnalyticsService."""

    L_OPEN, L_POOL, L_EXP, L_SAVE, L_CLOSE = 0, 1, 2, 3, 4

    def __init__(self, analytics: AnalyticsService) -> None:
        self.a = analytics

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def build(
        self,
        mode: str = "period",
        expanded: Optional[List[str]] = None,
        top_n: int = 8,
    ) -> dict:
        expanded_set = set(expanded or [])
        if mode == "timeline":
            return self._timeline_flow()
        if mode == "monthly":
            return self._monthly_flow(expanded_set, top_n)
        return self._period_summary(expanded_set, top_n)

    # ------------------------------------------------------------------
    # Period summary
    # ------------------------------------------------------------------

    def _period_summary(self, expanded: Set[str], top_n: int) -> dict:
        g = _Graph()
        opening, closing = self.a._boundary_net_worth()
        snap = self.a.financial_snapshot()
        pe = snap["personal_economics"]
        cf = snap["cash_flow"]
        income = self.a.income_detail()

        cash_in = cf["money_in"]
        cash_out = pe["net_personal_spend"]
        savings = closing - opening

        prefix = ""

        self._add_spine(
            g, prefix, opening, closing, cash_in, cash_out, savings,
            income, pe["refunds_recoveries"], expanded, top_n, period=None,
        )

        conservation = round(opening + cash_in - cash_out - closing, 2)
        flow_conservation = round(cash_in - cash_out - savings, 2)

        return {
            "mode": "period",
            "nodes": g.nodes,
            "links": g.links,
            "expanded": sorted(expanded),
            "periods": [],
            "savings_definition": "closing_balance − opening_balance",
            "reconciliation": {
                "opening_balance": round(opening, 2),
                "closing_balance": round(closing, 2),
                "cash_in": round(cash_in, 2),
                "cash_out": round(cash_out, 2),
                "total_income": round(cash_in, 2),
                "total_expense": round(pe["gross_expenses"], 2),
                "savings": round(savings, 2),
                "true_income": pe["true_income"],
                "refunds_recoveries": pe["refunds_recoveries"],
                "conservation_error": conservation,
                "flow_conservation_error": flow_conservation,
                "net_personal_spend": pe["net_personal_spend"],
                "gross_expenses": pe["gross_expenses"],
                "inflow_to_available": round(opening + cash_in, 2),
                "outflow_from_available": round(cash_out + max(savings, 0), 2),
                "balance_delta": round(savings, 2),
            },
            "monthly_reconciliation": [],
        }

    # ------------------------------------------------------------------
    # Monthly timeline
    # ------------------------------------------------------------------

    def _monthly_flow(self, expanded: Set[str], top_n: int) -> dict:
        g = _Graph()
        periods = self._periods_in_window()
        if not periods:
            return self._empty_monthly()

        monthly_rec: List[dict] = []
        prev_close_nid: Optional[str] = None
        prev_closing_val = 0.0
        prev_opening_val = 0.0
        prev_period: Optional[str] = None
        prev_savings = 0.0

        for i, period in enumerate(periods):
            metrics = self._month_metrics(period)
            opening = metrics["opening"]
            closing = metrics["closing"]
            cash_in = metrics["cash_in"]
            cash_out = metrics["cash_out"]
            savings = closing - opening
            prefix = f"{period}:"

            income = metrics["income_detail"]
            refunds = metrics["refunds"]

            carry_err = 0.0
            if i > 0:
                carry_err = round(prev_closing_val - opening, 2)

            self._add_spine(
                g, prefix, opening, closing, cash_in, cash_out, savings,
                income, refunds, expanded, top_n, period=period,
            )

            # Carry-forward: previous closing → this opening
            open_nid = f"{prefix}opening"
            if prev_close_nid is not None:
                g.link(
                    prev_close_nid,
                    open_nid,
                    abs(prev_savings) if abs(prev_savings) > 0.005 else prev_closing_val,
                    link_type="carry",
                    balance_amount=prev_closing_val,
                    period_from=prev_period,
                    period_to=period,
                )

            prev_close_nid = f"{prefix}closing"
            prev_closing_val = closing
            prev_opening_val = opening
            prev_period = period
            prev_savings = savings

            monthly_rec.append({
                "period": period,
                "opening_balance": round(opening, 2),
                "closing_balance": round(closing, 2),
                "cash_in": round(cash_in, 2),
                "cash_out": round(cash_out, 2),
                "total_income": round(cash_in, 2),
                "total_expense": round(metrics["gross_expenses"], 2),
                "true_income": round(metrics["true_income"], 2),
                "gross_expenses": round(metrics["gross_expenses"], 2),
                "savings": round(savings, 2),
                "carry_forward": round(savings, 2),
                "conservation_error": round(opening + cash_in - cash_out - closing, 2),
                "carry_forward_error": carry_err,
            })

        return {
            "mode": "monthly",
            "nodes": g.nodes,
            "links": g.links,
            "expanded": sorted(expanded),
            "periods": periods,
            "savings_definition": "closing_balance − opening_balance",
            "reconciliation": self._aggregate_monthly_rec(monthly_rec),
            "monthly_reconciliation": monthly_rec,
        }

    def _empty_monthly(self) -> dict:
        return {
            "mode": "monthly",
            "nodes": [],
            "links": [],
            "expanded": [],
            "periods": [],
            "savings_definition": "closing_balance − opening_balance",
            "reconciliation": {},
            "monthly_reconciliation": [],
        }

    # ------------------------------------------------------------------
    # Horizontal timeline — simplified spine per month (Opening → Income →
    # Expenses → Savings → Closing), laid out left-to-right on the frontend.
    # ------------------------------------------------------------------

    def _timeline_flow(self) -> dict:
        g = _Graph()
        periods = self._periods_in_window()
        if not periods:
            empty = self._empty_monthly()
            empty["mode"] = "timeline"
            return empty

        monthly_rec: List[dict] = []
        prev_close_nid: Optional[str] = None
        prev_closing_val = 0.0
        prev_period: Optional[str] = None

        for i, period in enumerate(periods):
            metrics = self._month_metrics(period)
            opening = metrics["opening"]
            closing = metrics["closing"]
            income = metrics["true_income"]
            cash_in = metrics["cash_in"]
            cash_out = metrics["cash_out"]
            refunds = metrics["refunds"]
            savings = closing - opening
            prefix = f"{period}:"

            g.node(f"{prefix}opening", "Opening", self.L_OPEN, opening,
                   period=period, node_type="opening", depth=0)
            g.node(f"{prefix}income", "Income", self.L_OPEN, income,
                   period=period, node_type="income", depth=0)
            g.node(f"{prefix}expenses", "Expenses", self.L_EXP, cash_out,
                   period=period, node_type="expense", depth=0)
            sav_label = "Savings" if savings >= 0 else "Drawdown"
            sav_type = "savings" if savings >= 0 else "drawdown"
            sav_nid = f"{prefix}savings"
            g.node(sav_nid, sav_label, self.L_SAVE, abs(savings),
                   period=period, node_type=sav_type, depth=0)
            g.node(f"{prefix}closing", "Closing", self.L_CLOSE, closing,
                   period=period, node_type="closing", depth=0)

            pool = f"{prefix}pool"
            pool_val = max(opening + cash_in, 0.005)
            g.node(pool, "Available", self.L_POOL, pool_val,
                   period=period, node_type="available", depth=0)

            if opening > 0.005:
                g.link(f"{prefix}opening", pool, opening)
            if income > 0.005:
                g.link(f"{prefix}income", pool, income)
            if refunds > 0.005:
                rid = f"{prefix}refunds"
                g.node(rid, "Refunds", self.L_OPEN, refunds,
                       period=period, node_type="refund", depth=0)
                g.link(rid, pool, refunds)
            if cash_out > 0.005:
                g.link(pool, f"{prefix}expenses", cash_out)
            if abs(savings) > 0.005:
                g.link(pool, sav_nid, abs(savings))
            g.link(sav_nid, f"{prefix}closing", max(abs(closing), 0.005))

            gap = round(opening + cash_in - cash_out - closing, 2)
            if abs(gap) > 0.005:
                bid = f"{prefix}bridge"
                g.node(bid, "Bridge", self.L_SAVE, abs(gap),
                       period=period, node_type="bridge", depth=0)
                if gap < 0:
                    g.link(bid, f"{prefix}closing", abs(gap))
                else:
                    g.link(pool, bid, abs(gap))

            if prev_close_nid is not None:
                g.link(
                    prev_close_nid,
                    f"{prefix}opening",
                    abs(prev_closing_val) if abs(prev_closing_val) > 0.005 else 0.01,
                    link_type="carry",
                    balance_amount=prev_closing_val,
                    period_from=prev_period,
                    period_to=period,
                )

            carry_err = 0.0
            if i > 0:
                carry_err = round(prev_closing_val - opening, 2)

            prev_close_nid = f"{prefix}closing"
            prev_closing_val = closing
            prev_period = period

            monthly_rec.append({
                "period": period,
                "opening_balance": round(opening, 2),
                "closing_balance": round(closing, 2),
                "cash_in": round(metrics["cash_in"], 2),
                "cash_out": round(cash_out, 2),
                "total_income": round(income, 2),
                "total_expense": round(metrics["gross_expenses"], 2),
                "true_income": round(income, 2),
                "gross_expenses": round(metrics["gross_expenses"], 2),
                "savings": round(savings, 2),
                "carry_forward": round(savings, 2),
                "conservation_error": round(opening + cash_in - cash_out - closing, 2),
                "carry_forward_error": carry_err,
            })

        return {
            "mode": "timeline",
            "nodes": g.nodes,
            "links": g.links,
            "expanded": [],
            "periods": periods,
            "savings_definition": "closing_balance − opening_balance",
            "reconciliation": self._aggregate_monthly_rec(monthly_rec),
            "monthly_reconciliation": monthly_rec,
        }

    def _aggregate_monthly_rec(self, rows: List[dict]) -> dict:
        if not rows:
            return {}
        return {
            "opening_balance": rows[0]["opening_balance"],
            "closing_balance": rows[-1]["closing_balance"],
            "cash_in": round(sum(r["cash_in"] for r in rows), 2),
            "cash_out": round(sum(r["cash_out"] for r in rows), 2),
            "total_income": round(sum(r["total_income"] for r in rows), 2),
            "total_expense": round(sum(r["total_expense"] for r in rows), 2),
            "true_income": round(sum(r["true_income"] for r in rows), 2),
            "gross_expenses": round(sum(r["gross_expenses"] for r in rows), 2),
            "net_personal_spend": round(sum(r["cash_out"] for r in rows), 2),
            "savings": round(rows[-1]["closing_balance"] - rows[0]["opening_balance"], 2),
            "conservation_error": round(sum(r["conservation_error"] for r in rows), 2),
            "max_carry_forward_error": round(
                max(abs(r["carry_forward_error"]) for r in rows), 2,
            ),
        }

    # ------------------------------------------------------------------
    # Spine builder (shared by period + monthly)
    # ------------------------------------------------------------------

    def _add_spine(
        self,
        g: _Graph,
        prefix: str,
        opening: float,
        closing: float,
        cash_in: float,
        cash_out: float,
        savings: float,
        income: dict,
        refunds: float,
        expanded: Set[str],
        top_n: int,
        period: Optional[str],
    ) -> None:
        avail = f"{prefix}available"
        save = f"{prefix}savings"
        close = f"{prefix}closing"

        g.node(avail, "Available funds", self.L_POOL, cash_in + opening,
               period=period, node_type="available")
        g.node(save, "Savings", self.L_SAVE, abs(savings),
               period=period, node_type="savings")
        g.node(close, "Closing balance", self.L_CLOSE, closing,
               period=period, node_type="closing")

        if opening > 0.005:
            op = f"{prefix}opening"
            g.node(op, "Opening balance", self.L_OPEN, opening,
                   period=period, node_type="opening")
            g.link(op, avail, opening)

        for row in income.get("by_subcategory", []):
            nid = f"{prefix}income:{_slug(row['subcategory'])}"
            g.node(nid, row["subcategory"], self.L_OPEN, row["amount"],
                   period=period, node_type="income")
            g.link(nid, avail, row["amount"])

        if refunds > 0.005:
            rid = f"{prefix}refunds"
            g.node(rid, "Refunds / recoveries", self.L_OPEN, refunds,
                   period=period, node_type="refund")
            g.link(rid, avail, refunds)

        # Expense tree — always all top-level categories
        self._add_expense_tree(g, prefix, expanded, top_n, period, avail, cash_out)

        if savings > 0.005:
            g.link(avail, save, savings)
            g.link(save, close, closing if closing > 0.005 else savings)
        elif savings < -0.005:
            g.node(f"{prefix}drawdown", "Drawdown", self.L_SAVE, abs(savings),
                   period=period, node_type="drawdown")
            g.link(avail, f"{prefix}drawdown", abs(savings))
            g.link(f"{prefix}drawdown", close, closing if closing > 0.005 else abs(savings))
        elif closing > 0.005:
            g.link(avail, close, closing)

        # When net-worth boundaries diverge from cash activity (CC timing, etc.)
        gap = round(opening + cash_in - cash_out - closing, 2)
        if abs(gap) > 0.005:
            bid = f"{prefix}balance-bridge"
            g.node(
                bid, "Balance bridge", self.L_SAVE, abs(gap),
                period=period, node_type="bridge",
            )
            if gap < 0:
                g.link(bid, close, abs(gap))
            else:
                g.link(avail, bid, abs(gap))

    def _add_expense_tree(
        self,
        g: _Graph,
        prefix: str,
        expanded: Set[str],
        top_n: int,
        period: Optional[str],
        avail_nid: str,
        total_spend: float,
    ) -> None:
        month_svc = self._scoped_analytics(period)
        buckets = month_svc._expense_net_buckets()
        items = sorted(buckets.items(), key=lambda x: -x[1])
        if len(items) > top_n:
            top = items[:top_n]
            other = sum(v for _, v in items[top_n:])
            items = top + ([("Other", other)] if other > 0.005 else [])

        for cat, amt in items:
            if amt <= 0.005:
                continue
            cat_slug = _slug(cat)
            cat_nid = f"{prefix}expense:{cat_slug}"
            is_exp = cat_nid in expanded
            g.node(
                cat_nid, cat, self.L_EXP, amt,
                depth=0, expandable=True, expanded=is_exp,
                period=period, node_type="expense",
            )
            g.link(avail_nid, cat_nid, amt)

            if is_exp:
                self._expand_category(g, prefix, cat, cat_nid, expanded, period, depth=1)

    def _expand_category(
        self,
        g: _Graph,
        prefix: str,
        category: str,
        cat_nid: str,
        expanded: Set[str],
        period: Optional[str],
        depth: int,
    ) -> None:
        month_svc = self._scoped_analytics(period)
        subs = month_svc._expense_net_buckets(category=category)
        for sub, amt in sorted(subs.items(), key=lambda x: -x[1]):
            if amt <= 0.005:
                continue
            sub_slug = _slug(sub)
            sub_nid = f"{cat_nid}:{sub_slug}"
            is_exp = sub_nid in expanded
            g.node(
                sub_nid, sub, self.L_EXP, amt,
                parent_id=cat_nid, depth=depth,
                expandable=True, expanded=is_exp,
                period=period, node_type="expense",
            )
            g.link(cat_nid, sub_nid, amt, link_type="tree")

            if is_exp:
                self._expand_subcategory(
                    g, prefix, category, sub, sub_nid, expanded, period, depth + 1,
                )

    def _expand_subcategory(
        self,
        g: _Graph,
        prefix: str,
        category: str,
        subcategory: str,
        sub_nid: str,
        expanded: Set[str],
        period: Optional[str],
        depth: int,
    ) -> None:
        month_svc = self._scoped_analytics(period)
        cps = month_svc._expense_net_buckets(category=category, subcategory=subcategory)
        for cp, amt in sorted(cps.items(), key=lambda x: -x[1])[:12]:
            if amt <= 0.005:
                continue
            cp_slug = _slug(cp)
            cp_nid = f"{sub_nid}:{cp_slug}"
            g.node(
                cp_nid, cp, self.L_EXP, amt,
                parent_id=sub_nid, depth=depth,
                expandable=False, expanded=False,
                period=period, node_type="expense",
            )
            g.link(sub_nid, cp_nid, amt, link_type="tree")

    # ------------------------------------------------------------------
    # Month metrics
    # ------------------------------------------------------------------

    def _periods_in_window(self) -> List[str]:
        rows = self.a.monthly_series()
        return sorted(r.period for r in rows)

    def _month_metrics(self, period: str) -> dict:
        y, m = int(period[:4]), int(period[5:7])
        first = date(y, m, 1)
        last = date(y, m, calendar.monthrange(y, m)[1])

        month_a = AnalyticsService(self.a.s, date_from=first, date_to=last)
        snap = month_a.financial_snapshot()
        cf = snap["cash_flow"]
        pe = snap["personal_economics"]
        income = month_a.income_detail()

        opening = self._net_worth_at(first - timedelta(days=1))
        if opening == 0.0:
            opening = self._net_worth_at(first)
        closing = self._net_worth_at(last)

        return {
            "opening": opening,
            "closing": closing,
            "cash_in": cf["money_in"],
            "cash_out": pe["net_personal_spend"],
            "true_income": pe["true_income"],
            "gross_expenses": pe["gross_expenses"],
            "income_detail": income,
            "refunds": pe["refunds_recoveries"],
        }

    def _net_worth_at(self, d: date) -> float:
        full = AnalyticsService(self.a.s).net_worth_series()
        if not full:
            return 0.0
        target = d.isoformat()
        best = 0.0
        found = False
        for pt in full:
            if pt["date"] <= target:
                best = float(pt["net_worth"])
                found = True
            else:
                break
        return best if found else (float(full[0]["net_worth"]) if full else 0.0)

    def _scoped_analytics(self, period: Optional[str]) -> AnalyticsService:
        if not period:
            return self.a
        y, m = int(period[:4]), int(period[5:7])
        first = date(y, m, 1)
        last = date(y, m, calendar.monthrange(y, m)[1])
        return AnalyticsService(self.a.s, date_from=first, date_to=last)


def _slug(label: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", label.strip()).strip("-").lower()
    return s or "item"
