"""Categorize UI endpoints — groups, review queues, rule preview helpers.

Mounted at ``/api/categorize``. See ``docs/RULE_ENGINE.md``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from db.database import fastapi_session
from services.categorize_ui_service import CategorizeUIService


router = APIRouter(prefix="/api/categorize", tags=["categorize"])


class EnrichedGroupOut(BaseModel):
    key: str
    label: str
    kind: str
    txn_count: int
    total_amount: float
    expense_amount: float = 0.0
    income_amount: float = 0.0
    uncategorized_count: int = 0
    has_category: bool = False
    top_category: Optional[str] = None


class ReviewQueueItem(BaseModel):
    label: str
    amount: float
    txn_count: int


class ReviewQueuesOut(BaseModel):
    top_vpas: List[ReviewQueueItem]
    top_counterparties: List[ReviewQueueItem]
    top_descriptions: List[ReviewQueueItem]


class RulePreviewIn(BaseModel):
    conditions: Dict[str, Any]
    limit: int = Field(100, ge=1, le=500)
    only_uncategorized: bool = False
    proposed_category: Optional[str] = None
    proposed_subcategory: Optional[str] = None


class RulePreviewTxnOut(BaseModel):
    id: str
    date: Optional[str] = None
    description: str
    amount: float
    type: str
    merchant_name: Optional[str] = None
    vpa: Optional[str] = None
    category: Optional[str] = None
    subcategory: Optional[str] = None
    proposed_category: Optional[str] = None
    proposed_subcategory: Optional[str] = None


class RulePreviewOut(BaseModel):
    match_count: int
    total_amount: float
    expense_amount: float
    income_amount: float
    transactions: List[RulePreviewTxnOut]
    rows_evaluated: int = 0
    rows_skipped_tagged: int = 0
    rows_total: int = 0
    only_uncategorized: bool = False
    dataset_scope: str = "real_flow"


class RuleAnalyticsOut(BaseModel):
    total_rules: int
    active_rules: int
    disabled_rules: int
    transactions_by_rules: int
    transactions_manual: int
    transactions_auto_other: int


@router.get("/groups", response_model=List[EnrichedGroupOut])
def list_groups(
    kind: str = Query("vpa", description="vpa | merchant | combined"),
    db: Session = Depends(fastapi_session),
) -> List[EnrichedGroupOut]:
    if kind not in ("vpa", "merchant", "combined"):
        kind = "vpa"
    svc = CategorizeUIService(db)
    return [EnrichedGroupOut(**g) for g in svc.groups_by_kind(kind)]


@router.get("/review-queues", response_model=ReviewQueuesOut)
def review_queues(
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(fastapi_session),
) -> ReviewQueuesOut:
    return ReviewQueuesOut(**CategorizeUIService(db).review_queues(limit))


@router.get("/rule-analytics", response_model=RuleAnalyticsOut)
def rule_analytics(db: Session = Depends(fastapi_session)) -> RuleAnalyticsOut:
    return RuleAnalyticsOut(**CategorizeUIService(db).rule_analytics())


@router.post("/preview-rule", response_model=RulePreviewOut)
def preview_rule(body: RulePreviewIn, db: Session = Depends(fastapi_session)) -> RulePreviewOut:
    raw = CategorizeUIService(db).preview_conditions(
        body.conditions,
        limit=body.limit,
        only_uncategorized=body.only_uncategorized,
    )
    txns = []
    for t in raw["transactions"]:
        txns.append(RulePreviewTxnOut(
            **t,
            proposed_category=body.proposed_category,
            proposed_subcategory=body.proposed_subcategory,
        ))
    return RulePreviewOut(
        match_count=raw["match_count"],
        total_amount=raw["total_amount"],
        expense_amount=raw["expense_amount"],
        income_amount=raw["income_amount"],
        transactions=txns,
        rows_evaluated=raw.get("rows_evaluated", 0),
        rows_skipped_tagged=raw.get("rows_skipped_tagged", 0),
        rows_total=raw.get("rows_total", 0),
        only_uncategorized=raw.get("only_uncategorized", False),
        dataset_scope=raw.get("dataset_scope", "real_flow"),
    )
