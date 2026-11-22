"""Blinkit order-invoice extraction API."""

from __future__ import annotations

import csv
import io
import logging
import os
import tempfile
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from api.schemas import (
    BlinkitAnalyticsSummaryOut,
    BlinkitAnnexureOut,
    BlinkitBrandRowOut,
    BlinkitCategorizeOut,
    CategorizationJobOut,
    CategorizationJobStartIn,
    BlinkitCategoryRowOut,
    BlinkitCategoryTrendRowOut,
    BlinkitDrilldownOut,
    BlinkitDrilldownOrderRowOut,
    BlinkitDrilldownProductRowOut,
    BlinkitDrilldownSummaryOut,
    BlinkitExplorerListOut,
    BlinkitSubcategoryRowOut,
    BlinkitExplorerRowOut,
    BlinkitIngestOut,
    BlinkitInsightsOut,
    BlinkitLocationBreakdownOut,
    BlinkitLocationRowOut,
    BlinkitOrderBucketOut,
    BlinkitOrderItemOut,
    BlinkitOrderListOut,
    BlinkitOrderOut,
    BlinkitParseErrorOut,
    BlinkitProductDetailOut,
    BlinkitProductRankOut,
    BlinkitSellerRowOut,
    BlinkitSpendingPeriodOut,
    BlinkitStatsOut,
    BlinkitStoreRowOut,
)
from db.database import fastapi_session
from db.models import (
    BlinkitAnnexureChargeRecord,
    BlinkitOrder,
    BlinkitOrderItem,
    BlinkitParseErrorRecord,
    BlinkitScannedFileRecord,
)
from parsers.blinkit.pdf_parser import DEFAULT_INVOICE_DIR
from services.blinkit_analytics_service import BlinkitAnalyticsService
from services.blinkit_categorization_engine import BlinkitCategorizationEngine
from services.blinkit_categorization_service import BlinkitCategorizationService
from services.categorization_job_manager import CategorizationJobManager
from services.blinkit_service import BlinkitIngestionService

router = APIRouter(prefix="/api/blinkit", tags=["blinkit"])
logger = logging.getLogger("finance-hub.blinkit")


def _analytics(db: Session, date_from: Optional[date], date_to: Optional[date]) -> BlinkitAnalyticsService:
    return BlinkitAnalyticsService(db, date_from=date_from, date_to=date_to)


@router.post("/scan", response_model=BlinkitIngestOut)
def scan_invoices(
    directory: Optional[str] = Query(default=None, description="Override invoice folder path"),
    db: Session = Depends(fastapi_session),
) -> BlinkitIngestOut:
    """Scan ~/Documents/Blinkit_Orders/ (or custom path) and ingest new orders."""
    svc = BlinkitIngestionService(db)
    result = svc.scan_directory(directory)
    return BlinkitIngestOut(
        files_processed=result.files_processed,
        orders_new=result.orders_new,
        orders_skipped=result.orders_skipped,
        items_new=result.items_new,
        errors=result.errors,
        warnings=result.warnings,
    )


@router.post("/reprocess", response_model=BlinkitIngestOut)
def reprocess_all(
    directory: Optional[str] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> BlinkitIngestOut:
    """Wipe all Blinkit data and re-parse every PDF from scratch.

    Use after a parser upgrade so previously-ingested orders benefit
    from improved extraction instead of being permanently skipped as
    duplicates.
    """
    svc = BlinkitIngestionService(db)
    result = svc.reprocess_all(directory)
    return BlinkitIngestOut(
        files_processed=result.files_processed,
        orders_new=result.orders_new,
        orders_skipped=result.orders_skipped,
        items_new=result.items_new,
        errors=result.errors,
        warnings=result.warnings,
    )


@router.post("/upload", response_model=BlinkitIngestOut)
async def upload_invoice(
    file: UploadFile = File(...),
    db: Session = Depends(fastapi_session),
) -> BlinkitIngestOut:
    """Upload a single Blinkit invoice PDF for extraction."""
    body = await file.read()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(body)
        tmp_path = tmp.name

    try:
        svc = BlinkitIngestionService(db)
        result = svc.ingest_pdf(tmp_path)
        return BlinkitIngestOut(
            files_processed=result.files_processed,
            orders_new=result.orders_new,
            orders_skipped=result.orders_skipped,
            items_new=result.items_new,
            errors=result.errors,
            warnings=result.warnings,
        )
    finally:
        os.unlink(tmp_path)


@router.get("/stats", response_model=BlinkitStatsOut)
def blinkit_stats(db: Session = Depends(fastapi_session)) -> BlinkitStatsOut:
    order_count = db.scalar(select(func.count()).select_from(BlinkitOrder)) or 0
    item_count = db.scalar(select(func.count()).select_from(BlinkitOrderItem)) or 0
    distinct_order_ids = db.scalar(
        select(func.count(func.distinct(BlinkitOrder.order_id)))
    ) or 0
    error_count = db.scalar(select(func.count()).select_from(BlinkitParseErrorRecord)) or 0
    files_scanned = db.scalar(select(func.count()).select_from(BlinkitScannedFileRecord)) or 0
    if files_scanned == 0:
        files_scanned = db.scalar(
            select(func.count(func.distinct(BlinkitOrder.source_file_hash)))
        ) or 0
    total_spend = db.scalar(select(func.sum(BlinkitOrder.grand_total))) or 0.0
    total_item_spend = db.scalar(select(func.sum(BlinkitOrder.item_total))) or 0.0
    total_fees = db.scalar(
        select(
            func.sum(
                func.coalesce(BlinkitOrder.delivery_fee, 0.0)
                + func.coalesce(BlinkitOrder.handling_charge, 0.0)
                + func.coalesce(BlinkitOrder.convenience_fee, 0.0)
                + func.coalesce(BlinkitOrder.packaging_charge, 0.0)
                + func.coalesce(BlinkitOrder.other_charges, 0.0)
            )
        )
    ) or 0.0

    return BlinkitStatsOut(
        order_count=order_count,
        item_count=item_count,
        distinct_order_ids=distinct_order_ids,
        error_count=error_count,
        files_scanned=files_scanned,
        total_spend=round(total_spend, 2),
        total_item_spend=round(total_item_spend, 2),
        total_fees=round(total_fees, 2),
        invoice_directory=DEFAULT_INVOICE_DIR,
    )


@router.get("/orders", response_model=BlinkitOrderListOut)
def list_orders(
    order_id: Optional[str] = Query(default=None),
    q: Optional[str] = Query(default=None, description="Free-text search across order/customer/seller/store/item fields"),
    limit: int = Query(default=100, le=1000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(fastapi_session),
) -> BlinkitOrderListOut:
    """List orders, newest first. Supports pagination and full-text search.

    ``q`` matches (case-insensitively) against: order id, invoice number,
    seller/customer/store name, delivery/store address, state, pincode,
    and — via a join — item name/UPC. Returns ``total`` so the UI can
    render pagination instead of silently truncating older records.
    """
    base = select(BlinkitOrder)
    count_base = select(func.count(func.distinct(BlinkitOrder.id))).select_from(BlinkitOrder)

    if order_id:
        base = base.where(BlinkitOrder.order_id == order_id)
        count_base = count_base.where(BlinkitOrder.order_id == order_id)

    if q:
        like = f"%{q.strip()}%"
        item_match = select(BlinkitOrderItem.order_id).where(
            or_(
                BlinkitOrderItem.product_name.ilike(like),
                BlinkitOrderItem.upc.ilike(like),
            )
        )
        search_filter = or_(
            BlinkitOrder.order_id.ilike(like),
            BlinkitOrder.invoice_number.ilike(like),
            BlinkitOrder.seller_name.ilike(like),
            BlinkitOrder.customer_name.ilike(like),
            BlinkitOrder.delivery_address.ilike(like),
            BlinkitOrder.delivery_state.ilike(like),
            BlinkitOrder.delivery_pincode.ilike(like),
            BlinkitOrder.store_name.ilike(like),
            BlinkitOrder.store_address.ilike(like),
            BlinkitOrder.store_state.ilike(like),
            BlinkitOrder.store_pincode.ilike(like),
            BlinkitOrder.id.in_(item_match),
        )
        base = base.where(search_filter)
        count_base = count_base.where(search_filter)

    total = db.scalar(count_base) or 0

    base = base.order_by(BlinkitOrder.invoice_date.desc(), BlinkitOrder.id.desc())
    base = base.offset(offset).limit(limit)
    rows = db.scalars(base).all()

    return BlinkitOrderListOut(
        orders=[_order_to_out(r) for r in rows],
        total=total,
    )


@router.get("/orders/{order_row_id}", response_model=BlinkitOrderOut)
def get_order(
    order_row_id: int,
    db: Session = Depends(fastapi_session),
) -> BlinkitOrderOut:
    row = db.scalar(
        select(BlinkitOrder)
        .options(
            selectinload(BlinkitOrder.items),
            selectinload(BlinkitOrder.annexure_charges),
        )
        .where(BlinkitOrder.id == order_row_id)
    )
    if not row:
        raise HTTPException(404, "Order not found")
    return _order_to_out(row, include_items=True)


@router.get("/items", response_model=List[BlinkitOrderItemOut])
def list_items(
    order_id: Optional[str] = Query(default=None),
    invoice_number: Optional[str] = Query(default=None),
    limit: int = Query(default=200, le=2000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(fastapi_session),
) -> List[BlinkitOrderItemOut]:
    q = (
        select(BlinkitOrderItem, BlinkitOrder)
        .join(BlinkitOrder, BlinkitOrderItem.order_id == BlinkitOrder.id)
        .order_by(BlinkitOrder.invoice_date.desc(), BlinkitOrderItem.id)
    )
    if order_id:
        q = q.where(BlinkitOrder.order_id == order_id)
    if invoice_number:
        q = q.where(BlinkitOrder.invoice_number == invoice_number)
    q = q.offset(offset).limit(limit)

    results = []
    for item, order in db.execute(q).all():
        results.append(_item_to_out(item, order))
    return results


@router.get("/errors", response_model=List[BlinkitParseErrorOut])
def list_errors(
    limit: int = Query(default=100, le=500),
    db: Session = Depends(fastapi_session),
) -> List[BlinkitParseErrorOut]:
    rows = db.scalars(
        select(BlinkitParseErrorRecord)
        .order_by(BlinkitParseErrorRecord.created_at.desc())
        .limit(limit)
    ).all()
    return [BlinkitParseErrorOut.model_validate(r) for r in rows]


def _item_to_out(item: BlinkitOrderItem, order: BlinkitOrder) -> BlinkitOrderItemOut:
    return BlinkitOrderItemOut(
        id=item.id, order_row_id=item.order_id,
        order_id=order.order_id, invoice_number=order.invoice_number,
        invoice_date=order.invoice_date,
        sr_no=item.sr_no, upc=item.upc, hsn_code=item.hsn_code,
        product_name=item.product_name, brand=item.brand,
        variant=item.variant, size_weight=item.size_weight,
        packaging=item.packaging, category=item.category,
        mrp=item.mrp, selling_price=item.selling_price, discount=item.discount,
        quantity=item.quantity, taxable_value=item.taxable_value,
        cgst_pct=item.cgst_pct, cgst_inr=item.cgst_inr,
        sgst_pct=item.sgst_pct, sgst_inr=item.sgst_inr,
        igst_pct=item.igst_pct, igst_inr=item.igst_inr,
        cess_pct=item.cess_pct, additional_cess_val=item.additional_cess_val,
        total_amount=item.total_amount,
        line_type=item.line_type,
    )


def _order_to_out(row: BlinkitOrder, include_items: bool = False) -> BlinkitOrderOut:
    items = []
    annexure = []
    if include_items:
        items = [_item_to_out(i, row) for i in row.items]
        annexure = [BlinkitAnnexureOut.model_validate(a) for a in row.annexure_charges]

    return BlinkitOrderOut(
        id=row.id,
        invoice_number=row.invoice_number,
        order_id=row.order_id,
        invoice_date=row.invoice_date,
        order_date=row.order_date,
        delivery_date=row.delivery_date,
        place_of_supply=row.place_of_supply,
        customer_name=row.customer_name,
        customer_phone=row.customer_phone,
        delivery_address=row.delivery_address,
        delivery_city=row.delivery_city,
        delivery_state=row.delivery_state,
        delivery_pincode=row.delivery_pincode,
        seller_name=row.seller_name,
        seller_gstin=row.seller_gstin,
        seller_fssai=row.seller_fssai,
        store_name=row.store_name,
        store_address=row.store_address,
        store_state=row.store_state,
        store_pincode=row.store_pincode,
        store_gstin=row.store_gstin,
        item_total=row.item_total,
        delivery_fee=row.delivery_fee,
        handling_charge=row.handling_charge,
        convenience_fee=row.convenience_fee,
        packaging_charge=row.packaging_charge,
        other_charges=row.other_charges,
        discount_total=row.discount_total,
        cgst_total=row.cgst_total,
        sgst_total=row.sgst_total,
        tax_total=row.tax_total,
        grand_total=row.grand_total,
        amount_paid=row.amount_paid,
        amount_in_words=row.amount_in_words,
        payment_method=row.payment_method,
        has_annexure=row.has_annexure,
        is_continuation_merged=row.is_continuation_merged,
        source_file=row.source_file,
        page_number=row.page_number,
        items=items,
        annexure_charges=annexure,
    )


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------


@router.post("/categorize", response_model=BlinkitCategorizeOut)
def categorize_products(
    refresh: bool = Query(default=False, description="Re-run categorization for non-manual products"),
    force_reclassify: bool = Query(default=False, description="Also re-run LLM for unresolved products"),
    force: bool = Query(default=False, description="Legacy alias: refresh + force_reclassify"),
    db: Session = Depends(fastapi_session),
) -> BlinkitCategorizeOut:
    """Run product categorization (rules first, optional LLM). Manual categories preserved."""
    logger.info(
        "categorize start refresh=%s force_reclassify=%s force=%s",
        refresh, force_reclassify, force,
    )
    try:
        result = BlinkitCategorizationService(db).categorize_all(
            refresh=refresh or force,
            force_reclassify=force_reclassify or force,
            force=force,
        )
    except Exception:
        logger.exception("categorize failed")
        raise
    logger.info(
        "categorize done processed=%s new=%s updated=%s llm=%s manual_skipped=%s ai=%s",
        result.products_processed, result.products_new, result.items_updated,
        result.llm_used, result.skipped_manual, result.ai_enabled,
    )
    return BlinkitCategorizeOut(
        products_processed=result.products_processed,
        products_new=result.products_new,
        items_updated=result.items_updated,
        llm_used=result.llm_used,
        skipped_manual=result.skipped_manual,
        ai_enabled=result.ai_enabled,
    )


@router.post("/categorize/jobs", response_model=CategorizationJobOut)
def start_categorization_job(body: CategorizationJobStartIn) -> CategorizationJobOut:
    """Start a background categorization job with live progress tracking."""
    if body.mode not in ("unclassified", "reclassify_all"):
        raise HTTPException(status_code=400, detail="mode must be unclassified or reclassify_all")
    try:
        job = BlinkitCategorizationEngine.start_job(body.mode)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return CategorizationJobOut(**job.to_dict())


@router.get("/categorize/jobs/active", response_model=Optional[CategorizationJobOut])
def get_active_categorization_job() -> Optional[CategorizationJobOut]:
    job = CategorizationJobManager.instance().get_active()
    return CategorizationJobOut(**job.to_dict()) if job else None


@router.post("/categorize/jobs/cancel", response_model=Optional[CategorizationJobOut])
def cancel_active_categorization_job() -> Optional[CategorizationJobOut]:
    """Stop whichever categorization job is currently running."""
    job = CategorizationJobManager.instance().cancel()
    if not job:
        return None
    return CategorizationJobOut(**job.to_dict())


@router.get("/categorize/jobs/{job_id}", response_model=CategorizationJobOut)
def get_categorization_job(job_id: str) -> CategorizationJobOut:
    job = CategorizationJobManager.instance().get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return CategorizationJobOut(**job.to_dict())


@router.post("/categorize/jobs/{job_id}/cancel", response_model=CategorizationJobOut)
def cancel_categorization_job(job_id: str) -> CategorizationJobOut:
    """Stop a running categorization job after the current batch step."""
    job = CategorizationJobManager.instance().cancel(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return CategorizationJobOut(**job.to_dict())


@router.get("/analytics/summary", response_model=BlinkitAnalyticsSummaryOut)
def analytics_summary(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> BlinkitAnalyticsSummaryOut:
    return BlinkitAnalyticsSummaryOut(**_analytics(db, date_from, date_to).summary())


@router.get("/analytics/spending-over-time", response_model=List[BlinkitSpendingPeriodOut])
def analytics_spending_over_time(
    granularity: str = Query(default="month", pattern="^(month|week|day)$"),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> List[BlinkitSpendingPeriodOut]:
    rows = _analytics(db, date_from, date_to).spending_over_time(granularity)
    return [BlinkitSpendingPeriodOut(**r) for r in rows]


@router.get("/analytics/categories", response_model=List[BlinkitCategoryRowOut])
def analytics_categories(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> List[BlinkitCategoryRowOut]:
    rows = _analytics(db, date_from, date_to).category_breakdown()
    return [BlinkitCategoryRowOut(**r) for r in rows]


@router.get("/analytics/subcategories", response_model=List[BlinkitSubcategoryRowOut])
def analytics_subcategories(
    category: Optional[str] = Query(default=None),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> List[BlinkitSubcategoryRowOut]:
    svc = _analytics(db, date_from, date_to)
    if category:
        rows = svc.subcategory_breakdown(category)
    else:
        rows = svc.subcategory_rankings(limit=20)
    return [BlinkitSubcategoryRowOut(**r) for r in rows]


@router.get("/analytics/category-trend", response_model=List[BlinkitCategoryTrendRowOut])
def analytics_category_trend(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> List[BlinkitCategoryTrendRowOut]:
    rows = _analytics(db, date_from, date_to).category_monthly_trend()
    return [BlinkitCategoryTrendRowOut(**r) for r in rows]


@router.get("/analytics/stacked-monthly")
def analytics_stacked_monthly(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
):
    return _analytics(db, date_from, date_to).stacked_monthly_by_category()


@router.get("/analytics/drilldown/summary", response_model=BlinkitDrilldownSummaryOut)
def analytics_drilldown_summary(
    dimension: str = Query(..., min_length=1),
    value: Optional[str] = Query(default=None),
    charge_type: Optional[str] = Query(default=None, pattern="^(delivery|handling|convenience)$"),
    discounted_only: bool = Query(default=False),
    tax_only: bool = Query(default=False),
    category_filter: Optional[str] = Query(default=None),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> BlinkitDrilldownSummaryOut:
    data = _analytics(db, date_from, date_to).drilldown_summary(
        dimension=dimension,
        value=value,
        charge_type=charge_type,
        discounted_only=discounted_only,
        tax_only=tax_only,
        category_filter=category_filter,
    )
    return BlinkitDrilldownSummaryOut(**data)


@router.get("/analytics/drilldown/products-in-category")
def analytics_products_in_category(
    category: str = Query(...),
    subcategory: Optional[str] = Query(default=None),
    limit: int = Query(default=10, le=50),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
):
    return _analytics(db, date_from, date_to).products_in_category(
        category, limit=limit, subcategory=subcategory,
    )


@router.get("/analytics/products", response_model=List[BlinkitProductRankOut])
def analytics_products(
    limit: int = Query(default=20, le=100),
    sort_by: str = Query(default="spend", pattern="^(spend|quantity)$"),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> List[BlinkitProductRankOut]:
    rows = _analytics(db, date_from, date_to).product_rankings(limit=limit, sort_by=sort_by)
    return [BlinkitProductRankOut(**r) for r in rows]


@router.get("/analytics/products/detail", response_model=BlinkitProductDetailOut)
def analytics_product_detail(
    name: str = Query(..., description="Exact product name"),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> BlinkitProductDetailOut:
    data = _analytics(db, date_from, date_to).product_detail(name)
    if not data["times_purchased"]:
        raise HTTPException(404, "Product not found in range")
    return BlinkitProductDetailOut(**data)


@router.get("/analytics/stores", response_model=List[BlinkitStoreRowOut])
def analytics_stores(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> List[BlinkitStoreRowOut]:
    return [BlinkitStoreRowOut(**r) for r in _analytics(db, date_from, date_to).store_breakdown()]


@router.get("/analytics/sellers", response_model=List[BlinkitSellerRowOut])
def analytics_sellers(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> List[BlinkitSellerRowOut]:
    return [BlinkitSellerRowOut(**r) for r in _analytics(db, date_from, date_to).seller_breakdown()]


@router.get("/analytics/locations", response_model=BlinkitLocationBreakdownOut)
def analytics_locations(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> BlinkitLocationBreakdownOut:
    data = _analytics(db, date_from, date_to).location_breakdown()
    return BlinkitLocationBreakdownOut(
        by_state=[BlinkitLocationRowOut(**r) for r in data["by_state"]],
        by_address=[BlinkitLocationRowOut(**r) for r in data["by_address"]],
    )


@router.get("/analytics/order-buckets", response_model=List[BlinkitOrderBucketOut])
def analytics_order_buckets(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> List[BlinkitOrderBucketOut]:
    return [BlinkitOrderBucketOut(**r) for r in _analytics(db, date_from, date_to).order_value_buckets()]


@router.get("/analytics/charges-over-time")
def analytics_charges_over_time(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
):
    return _analytics(db, date_from, date_to).charges_over_time()


@router.get("/analytics/discounts")
def analytics_discounts(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
):
    return _analytics(db, date_from, date_to).discount_analytics()


@router.get("/analytics/taxes")
def analytics_taxes(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
):
    return _analytics(db, date_from, date_to).tax_analytics()


@router.get("/analytics/behavior")
def analytics_behavior(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
):
    return _analytics(db, date_from, date_to).shopping_behavior()


@router.get("/analytics/brands", response_model=List[BlinkitBrandRowOut])
def analytics_brands(
    limit: int = Query(default=15, le=50),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> List[BlinkitBrandRowOut]:
    return [BlinkitBrandRowOut(**r) for r in _analytics(db, date_from, date_to).brand_breakdown(limit)]


@router.get("/analytics/insights", response_model=BlinkitInsightsOut)
def analytics_insights(
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> BlinkitInsightsOut:
    return BlinkitInsightsOut(insights=_analytics(db, date_from, date_to).insights())


@router.get("/analytics/drilldown", response_model=BlinkitDrilldownOut)
def analytics_drilldown(
    dimension: str = Query(..., min_length=1),
    value: Optional[str] = Query(default=None),
    tab: str = Query(default="orders", pattern="^(orders|products)$"),
    charge_type: Optional[str] = Query(default=None, pattern="^(delivery|handling|convenience)$"),
    discounted_only: bool = Query(default=False),
    tax_only: bool = Query(default=False),
    category_filter: Optional[str] = Query(default=None),
    q: Optional[str] = Query(default=None),
    sort_by: str = Query(default="invoice_date"),
    sort_dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    limit: int = Query(default=50, le=500),
    offset: int = Query(default=0, ge=0),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> BlinkitDrilldownOut:
    rows, total, label = _analytics(db, date_from, date_to).drilldown(
        dimension=dimension,
        value=value,
        tab=tab,
        charge_type=charge_type,
        discounted_only=discounted_only,
        tax_only=tax_only,
        category_filter=category_filter,
        q=q,
        sort_by=sort_by,
        sort_dir=sort_dir,
        limit=limit,
        offset=offset,
    )
    if tab == "products":
        return BlinkitDrilldownOut(
            tab=tab,
            dimension=dimension,
            value=value,
            label=label,
            total=total,
            products=[BlinkitDrilldownProductRowOut(**r) for r in rows],
        )
    return BlinkitDrilldownOut(
        tab=tab,
        dimension=dimension,
        value=value,
        label=label,
        total=total,
        orders=[BlinkitDrilldownOrderRowOut(**r) for r in rows],
    )


@router.get("/analytics/drilldown/export")
def export_drilldown_csv(
    dimension: str = Query(..., min_length=1),
    value: Optional[str] = Query(default=None),
    tab: str = Query(default="orders", pattern="^(orders|products)$"),
    charge_type: Optional[str] = Query(default=None, pattern="^(delivery|handling|convenience)$"),
    discounted_only: bool = Query(default=False),
    tax_only: bool = Query(default=False),
    category_filter: Optional[str] = Query(default=None),
    q: Optional[str] = Query(default=None),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
):
    rows = _analytics(db, date_from, date_to).drilldown_export(
        dimension=dimension,
        value=value,
        tab=tab,
        charge_type=charge_type,
        discounted_only=discounted_only,
        tax_only=tax_only,
        category_filter=category_filter,
        q=q,
    )
    buf = io.StringIO()
    if rows:
        writer = csv.DictWriter(buf, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    buf.seek(0)
    fname = f"blinkit_{tab}_{dimension}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={fname}"},
    )


@router.get("/explorer", response_model=BlinkitExplorerListOut)
def order_explorer(
    q: Optional[str] = Query(default=None),
    sort_by: str = Query(default="invoice_date"),
    sort_dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    limit: int = Query(default=50, le=500),
    offset: int = Query(default=0, ge=0),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
) -> BlinkitExplorerListOut:
    rows, total = _analytics(db, date_from, date_to).explorer(
        q=q, sort_by=sort_by, sort_dir=sort_dir, limit=limit, offset=offset,
    )
    return BlinkitExplorerListOut(
        rows=[BlinkitExplorerRowOut(**r) for r in rows],
        total=total,
    )


@router.get("/explorer/export")
def export_explorer_csv(
    q: Optional[str] = Query(default=None),
    date_from: Optional[date] = Query(default=None),
    date_to: Optional[date] = Query(default=None),
    db: Session = Depends(fastapi_session),
):
    rows, _ = _analytics(db, date_from, date_to).explorer(q=q, limit=10000, offset=0)
    buf = io.StringIO()
    if rows:
        writer = csv.DictWriter(buf, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=blinkit_orders.csv"},
    )
