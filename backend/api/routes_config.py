"""Application configuration endpoints (API keys, etc.)."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from db.database import fastapi_session
from services.app_config_service import AppConfigService, DEFAULT_GEMINI_MODEL
from services.blinkit_llm_categorizer import test_gemini_connection


router = APIRouter(prefix="/api/config", tags=["config"])


class ConfigUpdateIn(BaseModel):
    gemini_api_key: Optional[str] = Field(default=None, description="Leave unset to keep existing key")
    gemini_model: Optional[str] = None
    clear_gemini_api_key: bool = False
    gemini_rpm: Optional[int] = None
    gemini_tpm: Optional[int] = None
    gemini_delay_ms: Optional[int] = None
    gemini_max_retries: Optional[int] = None
    gemini_retry_backoff_s: Optional[float] = None
    gemini_batch_size: Optional[int] = None
    gemini_temperature: Optional[float] = None
    gemini_max_output_tokens: Optional[int] = None


class GeminiTestIn(BaseModel):
    api_key: Optional[str] = Field(default=None, description="Test this key; omit to test stored/env key")
    model: Optional[str] = Field(default=None, description="Model to test; omit to use saved/default")


class GeminiTestOut(BaseModel):
    ok: bool
    message: str
    model: Optional[str] = None


@router.get("")
def get_config(db: Session = Depends(fastapi_session)) -> dict:
    return AppConfigService(db).public_config()


@router.put("")
def update_config(body: ConfigUpdateIn, db: Session = Depends(fastapi_session)) -> dict:
    return AppConfigService(db).update_config(
        gemini_api_key=body.gemini_api_key,
        gemini_model=body.gemini_model,
        clear_gemini_api_key=body.clear_gemini_api_key,
        gemini_rpm=body.gemini_rpm,
        gemini_tpm=body.gemini_tpm,
        gemini_delay_ms=body.gemini_delay_ms,
        gemini_max_retries=body.gemini_max_retries,
        gemini_retry_backoff_s=body.gemini_retry_backoff_s,
        gemini_batch_size=body.gemini_batch_size,
        gemini_temperature=body.gemini_temperature,
        gemini_max_output_tokens=body.gemini_max_output_tokens,
    )


@router.post("/test-gemini", response_model=GeminiTestOut)
def test_gemini(body: GeminiTestIn, db: Session = Depends(fastapi_session)) -> GeminiTestOut:
    svc = AppConfigService(db)
    api_key = body.api_key.strip() if body.api_key else svc.get("gemini_api_key")
    model = (body.model or svc.get("gemini_model") or DEFAULT_GEMINI_MODEL).strip()
    if not api_key:
        return GeminiTestOut(ok=False, message="No Gemini API key configured")
    ok, message = test_gemini_connection(api_key, model)
    return GeminiTestOut(ok=ok, message=message, model=model if ok else None)
