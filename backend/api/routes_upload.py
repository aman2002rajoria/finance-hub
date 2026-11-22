"""Upload PDFs → ingest → return per-file results."""

from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.schemas import (
    UploadHistoryRow, UploadOut, UploadResult,
)
from db.database import fastapi_session
from db.models import Upload
from services import IngestionService


router = APIRouter(prefix="/api/upload", tags=["upload"])


@router.post("", response_model=UploadOut)
async def upload_pdfs(
    files: List[UploadFile] = File(...),
    password: Optional[str] = Form(default=None),
    force_bank: Optional[str] = Form(default=None),
    force_reparse: bool = Form(default=False),
    db: Session = Depends(fastapi_session),
) -> UploadOut:
    """Ingest one or more PDF statements.

    Returns a per-file :class:`UploadResult` with parse + dedup stats.
    ``force_reparse`` re-runs the parser for a previously uploaded file
    (txn-level dedupe still blocks duplicate ledger rows).
    """
    svc = IngestionService(db)
    results: List[UploadResult] = []
    for f in files:
        body = await f.read()
        r = svc.ingest_pdf_bytes(
            file_bytes=body,
            filename=f.filename or "(unnamed).pdf",
            password=password or None,
            force_bank=force_bank or None,
            force_reparse=bool(force_reparse),
        )
        results.append(UploadResult(
            filename=r.filename,
            bank=r.bank,
            account_name=r.account_name,
            pages_parsed=r.pages_parsed,
            parsed_count=r.parsed_count,
            new_count=r.new_count,
            duplicate_count=r.duplicate_count,
            parse_failure_count=r.parse_failure_count,
            period_start=r.period_start,
            period_end=r.period_end,
            cc_payments_tagged=r.cc_payments_tagged,
            rules_applied=r.rules_applied,
            income_autotagged=r.income_autotagged,
            skipped_already_uploaded=r.skipped_already_uploaded,
            force_reparsed=r.force_reparsed,
            errors=r.errors,
            warnings=r.warnings,
        ))
    return UploadOut(results=results)


@router.get("/history", response_model=List[UploadHistoryRow])
def upload_history(db: Session = Depends(fastapi_session)) -> List[UploadHistoryRow]:
    rows = db.scalars(select(Upload).order_by(Upload.uploaded_at.desc())).all()
    return [UploadHistoryRow.model_validate(r) for r in rows]
