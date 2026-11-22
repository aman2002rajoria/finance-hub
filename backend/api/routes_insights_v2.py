"""Read-only Overview insights: one month in detail, and what repeats.

Every rupee here goes through the same "real spend" rules as
``AnalyticsService`` (``_real_expense_where`` / ``_refund_where`` and the
projected EMI instalments), so the month total always equals the bar for
that month in ``/api/analytics/monthly``.

* ``GET /api/insights/month``     -- one month: daily spend, pace against
  the month before, what changed by category (with the merchant behind it)
  and the biggest single expenses.
* ``GET /api/insights/recurring`` -- payments that repeat every month, with
  the typical amount and the next expected date.

Nothing here writes to the database.
"""

from __future__ import annotations

import calendar
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from statistics import median
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from db.database import fastapi_session
from db.models import Transaction
from services import AnalyticsService
from utils.grouping import resolve_group_key


router = APIRouter(prefix="/api/insights", tags=["insights"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@dataclass
class _Event:
    """One signed contribution to real spend on one day."""
    day: date
    amount: float            # + spend, - refund
    category: str
    who: str                 # display name of the counterparty
    key: str                 # stable grouping key
    txn: Optional[Transaction] = None
    kind: str = "spend"      # spend | refund | emi


def _month_bounds(period: str) -> tuple[date, date]:
    y, m = int(period[:4]), int(period[5:7])
    return date(y, m, 1), date(y, m, calendar.monthrange(y, m)[1])


def _prev_period(period: str) -> str:
    y, m = int(period[:4]), int(period[5:7])
    return f"{y - 1}-12" if m == 1 else f"{y}-{m - 1:02d}"


def _add_month(d: date, day: int) -> date:
    y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return date(y, m, min(day, calendar.monthrange(y, m)[1]))


def _label(t: Transaction) -> tuple[str, str]:
    """(key, display) for a transaction's counterparty."""
    m = (t.merchant_name or "").strip()
    kind, key, label = resolve_group_key(t.vpa, t.merchant_name)
    if kind == "unmatched":
        desc = (t.description or "").strip()
        return f"desc:{desc.lower()[:40]}", desc[:40] or "Unknown"
    return key, m or label


def _events(db: Session, start: date, end: date) -> List[_Event]:
    """Every real-spend event in [start, end], signed, EMI-aware."""
    svc = AnalyticsService(db, date_from=start, date_to=end)
    out: List[_Event] = []
    for t in db.scalars(select(Transaction).where(svc._real_expense_where())):
        key, who = _label(t)
        out.append(_Event(t.date, float(t.amount), t.category or "Uncategorized", who, key, t))
    for t in db.scalars(select(Transaction).where(svc._refund_where())):
        key, who = _label(t)
        cat = t.refund_category or t.category or "Uncategorized"
        out.append(_Event(t.date, -float(t.amount), cat, who, key, t, "refund"))
    # EMI instalments are monthly; they land on the 1st of their month,
    # the same month /analytics/monthly puts them in.
    for ins, t in svc._iter_emi_instalments():
        y, m = int(ins.period[:4]), int(ins.period[5:7])
        d = date(y, m, 1)
        if d < start or d > end:
            continue
        cat = (t.category if t and t.category else "Uncategorized")
        who = f"EMI: {(t.merchant_name or t.description or 'instalment')[:32]}" if t else "EMI instalment"
        out.append(_Event(d, float(ins.amount), cat, who, f"emi:{ins.emi_id}", None, "emi"))
    return out


def _latest_data_date(db: Session) -> Optional[date]:
    return db.scalar(select(func.max(Transaction.date)))


def _periods_with_spend(db: Session) -> List[str]:
    svc = AnalyticsService(db)
    rows = db.execute(
        select(func.strftime("%Y-%m", Transaction.date).label("p"))
        .where(svc._real_expense_where())
        .group_by("p")
        .order_by("p")
    ).all()
    return [p for (p,) in rows if p]


# ---------------------------------------------------------------------------
# One month in detail
# ---------------------------------------------------------------------------


@router.get("/month")
def month_detail(
    period: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}$", description="YYYY-MM; defaults to the latest month with spend"),
    db: Session = Depends(fastapi_session),
) -> dict:
    periods = _periods_with_spend(db)
    if not periods:
        return {"period": None, "periods": [], "has_data": False}
    if period is None or period not in periods:
        if period is not None and period not in periods:
            raise HTTPException(404, f"No spending found in {period}")
        period = periods[-1]

    prev = _prev_period(period)
    start, end = _month_bounds(period)
    p_start, p_end = _month_bounds(prev)

    latest = _latest_data_date(db) or end
    # The month is "in progress" when the newest statement line falls inside it.
    as_of = min(end, latest) if latest >= start else end
    partial = as_of < end
    cut = as_of.day

    events = _events(db, p_start, end)
    cur = [e for e in events if start <= e.day <= as_of]
    prv = [e for e in events if p_start <= e.day <= p_end]
    prev_has_data = prev in periods
    # Like for like: when this month is still going, compare against the
    # same days of last month.
    prv_cut = [e for e in prv if e.day.day <= cut] if partial else prv

    # Daily totals and running totals.
    daily_cur: Dict[int, float] = defaultdict(float)
    for e in cur:
        daily_cur[e.day.day] += e.amount
    daily_prev: Dict[int, float] = defaultdict(float)
    for e in prv:
        daily_prev[e.day.day] += e.amount

    days_in_month = end.day
    days_in_prev = p_end.day
    daily = []
    cumulative = []
    run_c = run_p = 0.0
    for d in range(1, max(days_in_month, days_in_prev) + 1):
        if d <= days_in_month and d <= cut:
            run_c += daily_cur.get(d, 0.0)
            daily.append({"date": date(start.year, start.month, d).isoformat(), "day": d, "amount": round(daily_cur.get(d, 0.0), 2)})
        if d <= days_in_prev:
            run_p += daily_prev.get(d, 0.0)
        if d <= days_in_month:
            cumulative.append({
                "day": d,
                "this_month": round(run_c, 2) if d <= cut else None,
                "last_month": round(run_p, 2) if (prev_has_data and d <= days_in_prev) else None,
            })

    total = round(sum(e.amount for e in cur), 2)
    prev_total = round(sum(e.amount for e in prv), 2)
    prev_same_point = round(sum(e.amount for e in prv_cut), 2)

    # What changed, by category, with the merchant that moved the most.
    def by_cat(evs: List[_Event]) -> Dict[str, float]:
        out: Dict[str, float] = defaultdict(float)
        for e in evs:
            out[e.category] += e.amount
        return out

    def by_cat_who(evs: List[_Event]) -> Dict[tuple, float]:
        out: Dict[tuple, float] = defaultdict(float)
        for e in evs:
            out[(e.category, e.key)] += e.amount
        return out

    names: Dict[str, str] = {e.key: e.who for e in prv_cut}
    names.update({e.key: e.who for e in cur})
    c_cat, p_cat = by_cat(cur), by_cat(prv_cut)
    c_cw, p_cw = by_cat_who(cur), by_cat_who(prv_cut)
    changes = []
    if prev_has_data:
        for cat in set(c_cat) | set(p_cat):
            delta = c_cat.get(cat, 0.0) - p_cat.get(cat, 0.0)
            if abs(delta) < 1:
                continue
            # Merchant whose change points the same way and is largest.
            best_key, best_d = None, 0.0
            for (c, k) in set(c_cw) | set(p_cw):
                if c != cat:
                    continue
                d = c_cw.get((c, k), 0.0) - p_cw.get((c, k), 0.0)
                if (d > 0) == (delta > 0) and abs(d) > abs(best_d):
                    best_key, best_d = k, d
            changes.append({
                "category": cat,
                "current": round(c_cat.get(cat, 0.0), 2),
                "previous": round(p_cat.get(cat, 0.0), 2),
                "delta": round(delta, 2),
                "top_counterparty": names.get(best_key) if best_key else None,
                "top_counterparty_delta": round(best_d, 2) if best_key else None,
                # Share of the category's change explained by that one merchant.
                "top_counterparty_share": round(abs(best_d) / abs(delta), 2) if best_key and delta else None,
            })
        changes.sort(key=lambda r: abs(r["delta"]), reverse=True)

    # Biggest single expenses (real spend only, refunds and EMI rows excluded).
    singles = sorted((e for e in cur if e.kind == "spend" and e.txn is not None), key=lambda e: e.amount, reverse=True)[:6]
    biggest = [{
        "id": e.txn.id,
        "date": e.day.isoformat(),
        "name": e.who,
        "description": e.txn.description,
        "category": e.category,
        "account_name": e.txn.account_name,
        "amount": round(e.amount, 2),
    } for e in singles]

    spend_days = sum(1 for d in daily if d["amount"] > 0)
    return {
        "has_data": True,
        "period": period,
        "prev_period": prev if prev_has_data else None,
        "periods": periods,
        "as_of": as_of.isoformat(),
        "is_partial": partial,
        "days_in_month": days_in_month,
        "days_elapsed": cut,
        "total": total,
        "prev_total": prev_total if prev_has_data else None,
        "prev_same_point": prev_same_point if prev_has_data else None,
        "txn_count": sum(1 for e in cur if e.kind == "spend"),
        "spend_days": spend_days,
        "daily": daily,
        "cumulative": cumulative,
        "changes": changes[:8],
        "biggest": biggest,
    }


# ---------------------------------------------------------------------------
# Recurring payments
# ---------------------------------------------------------------------------


@router.get("/recurring")
def recurring(
    months: int = Query(6, ge=3, le=24, description="How many months back to look"),
    db: Session = Depends(fastapi_session),
) -> dict:
    """Payments that land about once a month for an amount that barely moves.

    A counterparty counts when, in the last ``months`` months of data, it has
    a charge within 15% of its typical amount in at least 3 different months,
    about one such charge per month on roughly the same day, and was still
    charged in the last six weeks (so a food app you use weekly is not a bill).
    """
    latest = _latest_data_date(db)
    if latest is None:
        return {"items": [], "monthly_total": 0.0, "as_of": None, "months": months}
    # Window: the last N whole-or-partial months up to the newest data.
    y, m = latest.year, latest.month - (months - 1)
    while m <= 0:
        y, m = y - 1, m + 12
    start = date(y, m, 1)

    events = [e for e in _events(db, start, latest) if e.kind in ("spend", "emi")]
    groups: Dict[str, List[_Event]] = defaultdict(list)
    for e in events:
        groups[e.key].append(e)

    items = []
    for key, evs in groups.items():
        typical = median(e.amount for e in evs)
        if typical < 50:
            continue
        steady = [e for e in evs if abs(e.amount - typical) <= 0.15 * typical]
        month_set = {(e.day.year, e.day.month) for e in steady}
        if len(month_set) < 3:
            continue
        # About one steady charge a month, and most of this payee's charges
        # are that steady one (a food app used weekly is not a bill).
        if len(steady) > 1.25 * len(month_set) or len(steady) < 0.7 * len(evs):
            continue
        steady.sort(key=lambda e: e.day)
        usual_day = int(median(e.day.day for e in steady))
        # Lands on roughly the same day each month.
        if median(abs(e.day.day - usual_day) for e in steady) > 4:
            continue
        last = steady[-1]
        # Still running: seen within the last ~6 weeks of data.
        if (latest - last.day).days > 45:
            continue
        next_date = _add_month(last.day, usual_day)
        cats = defaultdict(int)
        for e in steady:
            cats[e.category] += 1
        items.append({
            "name": last.who,
            "category": max(cats, key=cats.get),
            "typical_amount": round(median(e.amount for e in steady), 2),
            "months_seen": len(month_set),
            "last_date": last.day.isoformat(),
            "last_amount": round(last.amount, 2),
            "usual_day": usual_day,
            "next_date": next_date.isoformat(),
            "is_emi": key.startswith("emi:"),
        })

    items.sort(key=lambda r: r["typical_amount"], reverse=True)
    return {
        "as_of": latest.isoformat(),
        "months": months,
        "window_start": start.isoformat(),
        "monthly_total": round(sum(i["typical_amount"] for i in items), 2),
        "items": items,
    }
