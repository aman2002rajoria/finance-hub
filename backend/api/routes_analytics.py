"""Read-only analytics endpoints powering the dashboard."""

from __future__ import annotations

from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.schemas import (
    AccountOut, AnalyticsReviewQueuesOut, BalancePoint, CCReconciliationRow,
    CategorizationProgress, CategoryInsightsOut, CategoryOut, CategoryTrendSeriesOut,
    CounterpartyOut, ExpenseDrilldownOut, FinancialSnapshotOut, HeadlineMetrics,
    IncomeBreakdownRow, IncomeDetailOut, MonthlyCategoryCell, MonthlyOut,
    MonthlySubcategoryCell, MonthlySummaryRow, NetWorthPoint, SankeyOut,
    SavingsDriversOut,
)
from db.database import fastapi_session
from db.models import Account
from services import AnalyticsService
from services.insights_service import InsightsService


router = APIRouter(prefix="/api/analytics", tags=["analytics"])

# All date-filtered endpoints accept optional ``date_from`` / ``date_to``
# query parameters in ISO-8601 format (YYYY-MM-DD). When omitted the
# endpoint returns data for the entire history (unchanged behaviour).
_DATE_PARAMS = dict(
    date_from=Query(None, description="ISO date — include transactions on/after this date"),
    date_to=Query(None,   description="ISO date — include transactions on/before this date"),
)


def _svc(db: Session, date_from: Optional[date], date_to: Optional[date]) -> AnalyticsService:
    """Build an AnalyticsService with the given date window."""
    return AnalyticsService(db, date_from=date_from, date_to=date_to)


def _insights(db: Session, date_from: Optional[date], date_to: Optional[date]) -> InsightsService:
    return InsightsService(_svc(db, date_from, date_to))


# ---------------------------------------------------------------------------
# Accounts (so the UI can populate filters / dashboard tiles)
# ---------------------------------------------------------------------------


@router.get("/accounts", response_model=List[AccountOut])
def accounts(db: Session = Depends(fastapi_session)) -> List[AccountOut]:
    return [AccountOut.model_validate(a) for a in db.scalars(select(Account).order_by(Account.name))]


# ---------------------------------------------------------------------------
# Headline + breakdowns
# ---------------------------------------------------------------------------


@router.get("/headline", response_model=HeadlineMetrics)
def headline(
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> HeadlineMetrics:
    return HeadlineMetrics(**_svc(db, date_from, date_to).headline())


@router.get("/snapshot", response_model=FinancialSnapshotOut)
def financial_snapshot(
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> FinancialSnapshotOut:
    """§1 Financial Snapshot — cash flow + true personal economics."""
    return FinancialSnapshotOut(**_svc(db, date_from, date_to).financial_snapshot())


@router.get("/monthly", response_model=List[MonthlyOut])
def monthly(
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> List[MonthlyOut]:
    rows = _svc(db, date_from, date_to).monthly_series()
    return [MonthlyOut(**r.__dict__) for r in rows]


@router.get("/categories", response_model=List[CategoryOut])
def categories(
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> List[CategoryOut]:
    rows = _svc(db, date_from, date_to).category_breakdown()
    return [CategoryOut(**r.__dict__) for r in rows]


@router.get("/balance-trend", response_model=List[BalancePoint])
def balance_trend(
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> List[BalancePoint]:
    """End-of-day balance per savings account.

    The balance history is computed from the *full* dataset — the date
    range only clips the visible window. So when zoomed to "Last 1
    month", the first point already shows the carry-forward balance
    rather than zero.
    """
    rows = _svc(db, date_from, date_to).balance_trend()
    return [BalancePoint(**r) for r in rows]


@router.get("/net-worth", response_model=List[NetWorthPoint])
def net_worth(
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> List[NetWorthPoint]:
    rows = _svc(db, date_from, date_to).net_worth_series()
    return [NetWorthPoint(**r) for r in rows]


@router.get("/counterparties", response_model=List[CounterpartyOut])
def counterparties(
    limit: int = Query(20, ge=1, le=200),
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> List[CounterpartyOut]:
    rows = _svc(db, date_from, date_to).top_counterparties(limit=limit)
    return [CounterpartyOut(**r) for r in rows]


@router.get("/categorization-progress", response_model=CategorizationProgress)
def progress(
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> CategorizationProgress:
    return CategorizationProgress(**_svc(db, date_from, date_to).categorization_progress())


@router.get("/income-breakdown", response_model=List[IncomeBreakdownRow])
def income_breakdown(
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> List[IncomeBreakdownRow]:
    """Splits income credits by (category, subcategory). Refunds excluded."""
    return [
        IncomeBreakdownRow(**r)
        for r in _svc(db, date_from, date_to).income_breakdown()
    ]


@router.get("/income-detail", response_model=IncomeDetailOut)
def income_detail(
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> IncomeDetailOut:
    """Rich payload for the income dashboard.

    * ``total_income``       — Σ income credits (refunds excluded).
    * ``total_refunds``      — Σ refund credits, surfaced separately.
    * ``by_subcategory``     — Salary / Interest / Dividends / Pocket Money
                               / Scholarship / Other Income / Uncategorized.
    * ``refunds_by_category`` — refund credits keyed by the spend bucket
                               they offset (Food / Shopping / Travel / …).
    * ``monthly_trend``       — one point per (period, subcategory) for
                                stacked-bar / multi-line plotting.
    """
    return IncomeDetailOut(**_svc(db, date_from, date_to).income_detail())


@router.get("/monthly-by-category", response_model=List[MonthlyCategoryCell])
def monthly_by_category(
    # The service treats top_n >= 50 as "keep every category" (the dashboard
    # asks for 50), so the cap must allow at least that.
    top_n: int = Query(5, ge=1, le=100),
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> List[MonthlyCategoryCell]:
    """Long-format ``(period, category, amount)`` cells — refund-aware."""
    return [
        MonthlyCategoryCell(**r)
        for r in _svc(db, date_from, date_to).monthly_by_category(top_n=top_n)
    ]


@router.get("/cc-reconciliation", response_model=List[CCReconciliationRow])
def cc_reconciliation(
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> List[CCReconciliationRow]:
    """Month-by-month CC spend vs amount paid, per CC account."""
    return [
        CCReconciliationRow(**r)
        for r in _svc(db, date_from, date_to).cc_reconciliation()
    ]


@router.get("/sankey", response_model=SankeyOut)
def sankey(
    mode: str = Query("timeline", description="'period' summary, 'timeline' horizontal, or 'monthly' detailed"),
    expanded: Optional[str] = Query(None, description="Comma-separated node ids to expand"),
    expand: Optional[str] = Query(None, description="Legacy drill path e.g. Food or Food/Restaurants"),
    top_n: int = Query(8, ge=3, le=15),
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> SankeyOut:
    """§2 money-flow Sankey — period summary or monthly timeline."""
    expanded_ids = [x.strip() for x in expanded.split(",") if x.strip()] if expanded else None
    return SankeyOut(**_svc(db, date_from, date_to).sankey(
        mode=mode,
        expanded=expanded_ids,
        expand=expand,
        top_n=top_n,
    ))


@router.get("/expense-drilldown", response_model=ExpenseDrilldownOut)
def expense_drilldown(
    category: str = Query(..., min_length=1),
    subcategory: Optional[str] = Query(None),
    counterparty: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> ExpenseDrilldownOut:
    """§5 expense drill-down: category → subcategory → counterparty → txns."""
    return ExpenseDrilldownOut(**_svc(db, date_from, date_to).expense_drilldown(
        category=category,
        subcategory=subcategory,
        counterparty=counterparty,
        limit=limit,
    ))


@router.get("/review-queues", response_model=AnalyticsReviewQueuesOut)
def review_queues(
    limit: int = Query(15, ge=1, le=50),
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> AnalyticsReviewQueuesOut:
    """§6 uncategorized review queues for the active date window."""
    return AnalyticsReviewQueuesOut(**_svc(db, date_from, date_to).review_queues(limit))


@router.get("/monthly-summary", response_model=List[MonthlySummaryRow])
def monthly_summary(
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> List[MonthlySummaryRow]:
    """Per-month opening, income, expense, savings, closing with MoM deltas."""
    return [MonthlySummaryRow(**r) for r in _insights(db, date_from, date_to).monthly_summary()]


@router.get("/category-trends", response_model=CategoryTrendSeriesOut)
def category_trends(
    top_n: int = Query(15, ge=1, le=30),
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> CategoryTrendSeriesOut:
    return CategoryTrendSeriesOut(**_insights(db, date_from, date_to).category_trend_series(top_n=top_n))


@router.get("/monthly-by-subcategory", response_model=List[MonthlySubcategoryCell])
def monthly_by_subcategory(
    category: str = Query(..., min_length=1),
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> List[MonthlySubcategoryCell]:
    rows = _insights(db, date_from, date_to).monthly_by_subcategory(category)
    return [MonthlySubcategoryCell(**r) for r in rows]


@router.get("/category-insights", response_model=CategoryInsightsOut)
def category_insights(
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> CategoryInsightsOut:
    return CategoryInsightsOut(**_insights(db, date_from, date_to).category_insights())


@router.get("/savings-drivers", response_model=SavingsDriversOut)
def savings_drivers(
    period: Optional[str] = Query(None, description="YYYY-MM — defaults to latest month"),
    date_from: Optional[date] = Query(None),
    date_to:   Optional[date] = Query(None),
    db: Session = Depends(fastapi_session),
) -> SavingsDriversOut:
    return SavingsDriversOut(**_insights(db, date_from, date_to).savings_drivers(period=period))
