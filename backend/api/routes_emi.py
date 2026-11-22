"""EMI plan CRUD + schedule preview."""

from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.schemas import EMIIn, EMIInstalmentOut, EMIOut, EMIWithSchedule
from db.database import fastapi_session
from db.models import EMIRecord
from services import EMIService


router = APIRouter(prefix="/api/emi", tags=["emi"])


@router.get("", response_model=List[EMIOut])
def list_emis(db: Session = Depends(fastapi_session)) -> List[EMIOut]:
    svc = EMIService(db)
    return [EMIOut.model_validate(e) for e in svc.list_emis()]


@router.post("", response_model=EMIWithSchedule)
def create_emi(body: EMIIn, db: Session = Depends(fastapi_session)) -> EMIWithSchedule:
    svc = EMIService(db)
    try:
        emi = svc.convert_to_emi(
            txn_id=body.txn_id,
            tenure_months=body.tenure_months,
            start_date=body.start_date,
            note=body.note,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    schedule = svc.project_instalments(emi)
    return EMIWithSchedule(
        plan=EMIOut.model_validate(emi),
        schedule=[EMIInstalmentOut(**ins.__dict__) for ins in schedule],
    )


@router.delete("/{txn_id}")
def remove_emi(txn_id: str, db: Session = Depends(fastapi_session)) -> dict:
    svc = EMIService(db)
    ok = svc.remove_emi(txn_id)
    if not ok:
        raise HTTPException(404, "No EMI plan attached to this transaction")
    return {"deleted": 1}


@router.get("/{txn_id}/schedule", response_model=EMIWithSchedule)
def emi_schedule(txn_id: str, db: Session = Depends(fastapi_session)) -> EMIWithSchedule:
    emi = db.scalar(
        select(EMIRecord).where(EMIRecord.original_transaction_id == txn_id)
    )
    if not emi:
        raise HTTPException(404, "No EMI plan attached to this transaction")
    schedule = EMIService.project_instalments(emi)
    return EMIWithSchedule(
        plan=EMIOut.model_validate(emi),
        schedule=[EMIInstalmentOut(**ins.__dict__) for ins in schedule],
    )
