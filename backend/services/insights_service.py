"""Derived analytics — monthly summaries, category trends, insights, savings drivers."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from typing import Dict, List, Optional

from sqlalchemy import and_, func, select

from db.models import Transaction
from services.analytics_service import AnalyticsService
from services.sankey_service import SankeyService


class InsightsService:
    def __init__(self, analytics: AnalyticsService) -> None:
        self.a = analytics

  # ------------------------------------------------------------------
  # Monthly financial summary table
  # ------------------------------------------------------------------

    def monthly_summary(self) -> List[dict]:
        sk = SankeyService(self.a)
        periods = sk._periods_in_window()
        rows: List[dict] = []
        prev_savings: Optional[float] = None

        for period in periods:
            m = sk._month_metrics(period)
            opening = round(m["opening"], 2)
            closing = round(m["closing"], 2)
            true_income = round(m["true_income"], 2)
            total_expense = round(m["cash_out"], 2)
            savings = round(closing - opening, 2)
            savings_rate = round((savings / true_income) * 100, 1) if true_income > 0 else 0.0
            mom_savings: Optional[float] = None
            mom_savings_pct: Optional[float] = None
            if prev_savings is not None:
                mom_savings = round(savings - prev_savings, 2)
                if abs(prev_savings) > 0.005:
                    mom_savings_pct = round((mom_savings / abs(prev_savings)) * 100, 1)
            rows.append({
                "period": period,
                "opening_balance": opening,
                "total_income": true_income,
                "total_expense": total_expense,
                "net_savings": savings,
                "savings_rate_pct": savings_rate,
                "closing_balance": closing,
                "mom_savings_change": mom_savings,
                "mom_savings_change_pct": mom_savings_pct,
            })
            prev_savings = savings

        if rows:
            best = max(rows, key=lambda r: r["net_savings"])
            worst = min(rows, key=lambda r: r["net_savings"])
            for r in rows:
                r["is_best_savings_month"] = r["period"] == best["period"]
                r["is_worst_savings_month"] = r["period"] == worst["period"]

        return rows

  # ------------------------------------------------------------------
  # Category monthly trends (top-level + subcategory)
  # ------------------------------------------------------------------

    def monthly_by_subcategory(self, category: str) -> List[dict]:
        """``[{period, subcategory, amount}, …]`` for one expense category."""
        per_month = self.a.s.execute(
            select(
                func.strftime("%Y-%m", Transaction.date).label("period"),
                func.coalesce(Transaction.subcategory, "Uncategorized"),
                func.sum(Transaction.amount),
            )
            .where(
                self.a._real_expense_where(),
                func.coalesce(Transaction.category, "Uncategorized") == category,
            )
            .group_by("period", func.coalesce(Transaction.subcategory, "Uncategorized"))
        ).all()

        refunds = self.a.s.execute(
            select(
                func.strftime("%Y-%m", Transaction.date).label("period"),
                func.coalesce(Transaction.subcategory, "Uncategorized"),
                func.sum(Transaction.amount),
            )
            .where(
                self.a._refund_where(),
                func.coalesce(Transaction.refund_category, Transaction.category, "Uncategorized") == category,
            )
            .group_by("period", func.coalesce(Transaction.subcategory, "Uncategorized"))
        ).all()

        agg: Dict[tuple, float] = defaultdict(float)
        for period, sub, amt in per_month:
            agg[(period, sub)] += float(amt or 0.0)
        for ins, t in self.a._iter_emi_instalments():
            if (t.category or "Uncategorized") != category:
                continue
            sub = t.subcategory or "Uncategorized"
            agg[(ins.period, sub)] += ins.amount
        for period, sub, amt in refunds:
            agg[(period, sub)] -= float(amt or 0.0)

        out = [
            {"period": p, "subcategory": sub, "amount": round(amt, 2)}
            for (p, sub), amt in agg.items()
            if abs(amt) > 0.005
        ]
        out.sort(key=lambda r: (r["period"], r["subcategory"]))
        return out

    def category_trend_series(self, top_n: int = 15) -> dict:
        """Categories available + long-format monthly cells for charting."""
        cells = self.a.monthly_by_category(top_n=top_n)
        categories = sorted({c["category"] for c in cells})
        return {"categories": categories, "cells": cells}

  # ------------------------------------------------------------------
  # Auto-generated insights
  # ------------------------------------------------------------------

    def category_insights(self) -> dict:
        cells = self.a.monthly_by_category(top_n=20)
        by_cat: Dict[str, Dict[str, float]] = defaultdict(dict)
        for c in cells:
            by_cat[c["category"]][c["period"]] = c["amount"]

        periods = sorted({c["period"] for c in cells})
        insights: List[dict] = []

        if len(periods) >= 2:
            cur_p, prev_p = periods[-1], periods[-2]
            mom_changes: List[tuple] = []
            for cat, pmap in by_cat.items():
                cur = pmap.get(cur_p, 0.0)
                prev = pmap.get(prev_p, 0.0)
                if prev > 0.005:
                    pct = ((cur - prev) / prev) * 100
                    mom_changes.append((cat, pct, cur - prev))
            mom_changes.sort(key=lambda x: x[1], reverse=True)
            if mom_changes:
                top_inc = mom_changes[0]
                insights.append({
                    "kind": "mom_increase",
                    "title": "Largest increase this month",
                    "label": top_inc[0],
                    "value": round(top_inc[1], 1),
                    "unit": "percent",
                    "amount_delta": round(top_inc[2], 2),
                })
                dec = [x for x in mom_changes if x[1] < 0]
                if dec:
                    top_dec = min(dec, key=lambda x: x[1])
                    insights.append({
                        "kind": "mom_decrease",
                        "title": "Largest decrease this month",
                        "label": top_dec[0],
                        "value": round(top_dec[1], 1),
                        "unit": "percent",
                        "amount_delta": round(top_dec[2], 2),
                    })

        if len(periods) >= 2:
            window = periods[-6:] if len(periods) >= 6 else periods
            growth_rates: List[tuple] = []
            for cat, pmap in by_cat.items():
                first_p, last_p = window[0], window[-1]
                first_v = pmap.get(first_p, 0.0)
                last_v = pmap.get(last_p, 0.0)
                if first_v > 0.005:
                    pct = ((last_v - first_v) / first_v) * 100
                    growth_rates.append((cat, pct))
            growth_rates.sort(key=lambda x: x[1], reverse=True)
            if growth_rates:
                g = growth_rates[0]
                insights.append({
                    "kind": "fastest_growing",
                    "title": f"Fastest growing over {len(window)} months",
                    "label": g[0],
                    "value": round(g[1], 1),
                    "unit": "percent",
                })

        cats = self.a.category_breakdown()
        if cats:
            insights.append({
                "kind": "largest_category",
                "title": "Largest spending category",
                "label": cats[0].category,
                "value": cats[0].amount,
                "unit": "amount",
            })

        if len(periods) >= 2:
            cur_p, prev_p = periods[-1], periods[-2]
            growth_contrib: List[tuple] = []
            for cat, pmap in by_cat.items():
                delta = pmap.get(cur_p, 0.0) - pmap.get(prev_p, 0.0)
                if delta > 0:
                    growth_contrib.append((cat, delta))
            growth_contrib.sort(key=lambda x: x[1], reverse=True)
            if growth_contrib:
                g = growth_contrib[0]
                insights.append({
                    "kind": "expense_growth_driver",
                    "title": "Largest contributor to expense growth",
                    "label": g[0],
                    "value": round(g[1], 2),
                    "unit": "amount",
                })

        return {"insights": insights, "periods": periods}

  # ------------------------------------------------------------------
  # Savings driver analysis
  # ------------------------------------------------------------------

    def savings_drivers(self, period: Optional[str] = None) -> dict:
        summary = self.monthly_summary()
        if len(summary) < 2:
            return {
                "period": period,
                "comparison_period": None,
                "delta_savings": 0.0,
                "current_savings": 0.0,
                "previous_savings": 0.0,
                "direction": "flat",
                "drivers": [],
                "income_delta": 0.0,
            }

        if period:
            idx = next((i for i, r in enumerate(summary) if r["period"] == period), -1)
            if idx < 1:
                current = summary[-1]
                previous = summary[-2]
            else:
                current = summary[idx]
                previous = summary[idx - 1]
        else:
            current = summary[-1]
            previous = summary[-2]

        delta_savings = round(current["net_savings"] - previous["net_savings"], 2)
        income_delta = round(current["total_income"] - previous["total_income"], 2)
        direction = "improved" if delta_savings > 0 else ("declined" if delta_savings < 0 else "flat")

        cells = self.a.monthly_by_category(top_n=30)
        cur_p, prev_p = current["period"], previous["period"]
        by_cat: Dict[str, Dict[str, float]] = defaultdict(dict)
        for c in cells:
            by_cat[c["category"]][c["period"]] = c["amount"]

        drivers: List[dict] = []

        # Income change is often the primary savings driver — surface it first.
        if abs(income_delta) >= 1:
            drivers.append({
                "label": "Income",
                "category": "__income__",
                "spend_delta": income_delta,
                "current_spend": current["total_income"],
                "previous_spend": previous["total_income"],
                "driver_type": "income",
            })

        for cat, pmap in by_cat.items():
            spend_delta = round(pmap.get(cur_p, 0.0) - pmap.get(prev_p, 0.0), 2)
            if abs(spend_delta) < 0.005:
                continue
            drivers.append({
                "label": cat,
                "category": cat,
                "spend_delta": spend_delta,
                "current_spend": round(pmap.get(cur_p, 0.0), 2),
                "previous_spend": round(pmap.get(prev_p, 0.0), 2),
                "driver_type": "expense",
            })

        def _impact(d: dict) -> float:
            if d.get("driver_type") == "income":
                return d["spend_delta"]
            return -d["spend_delta"]

        drivers.sort(key=_impact)
        if direction == "declined":
            drivers = [d for d in drivers if _impact(d) < -0.005]
        elif direction == "improved":
            drivers = [d for d in drivers if _impact(d) > 0.005]
        else:
            drivers = [d for d in drivers if abs(_impact(d)) > 0.005]

        return {
            "period": current["period"],
            "comparison_period": previous["period"],
            "delta_savings": delta_savings,
            "current_savings": current["net_savings"],
            "previous_savings": previous["net_savings"],
            "income_delta": income_delta,
            "direction": direction,
            "drivers": drivers[:10],
        }
