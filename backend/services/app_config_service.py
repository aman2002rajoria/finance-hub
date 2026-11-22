"""Persistent application configuration (API keys, models, etc.)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from db.models import AppSetting

# Extensible registry — add future keys here.
_SETTING_DEFS: Dict[str, Dict[str, Any]] = {
    "gemini_api_key": {
        "secret": True,
        "env_fallback": ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    },
    "gemini_model": {
        "secret": False,
        "default": "gemini-2.0-flash-lite",
        "env_fallback": ("GEMINI_MODEL",),
    },
}

# Curated list for the Settings UI — lite models usually have higher free-tier quota.
GEMINI_MODEL_OPTIONS: List[Dict[str, str]] = [
    {
        "id": "gemini-2.0-flash-lite",
        "label": "Gemini 2.0 Flash Lite",
        "hint": "Recommended — higher free-tier quota, fast",
    },
    {
        "id": "gemini-2.5-flash-lite",
        "label": "Gemini 2.5 Flash Lite",
        "hint": "Newer lite model, good free-tier limits",
    },
    {
        "id": "gemini-1.5-flash",
        "label": "Gemini 1.5 Flash",
        "hint": "Stable, widely available on free tier",
    },
    {
        "id": "gemini-1.5-flash-8b",
        "label": "Gemini 1.5 Flash 8B",
        "hint": "Smallest / cheapest — best when quota is tight",
    },
    {
        "id": "gemini-2.0-flash",
        "label": "Gemini 2.0 Flash",
        "hint": "Higher quality; free-tier quota may be limited",
    },
    {
        "id": "gemini-2.5-flash",
        "label": "Gemini 2.5 Flash",
        "hint": "Latest flash — may require paid tier",
    },
]

DEFAULT_GEMINI_MODEL = "gemini-2.0-flash-lite"


@dataclass
class GeminiConfigStatus:
    configured: bool
    masked: Optional[str]
    model: str
    source: str  # "db" | "env" | "none"


class AppConfigService:
    def __init__(self, db: Session):
        self.db = db

    def get(self, key: str) -> Optional[str]:
        row = self.db.scalar(select(AppSetting).where(AppSetting.key == key))
        if row and row.value.strip():
            return row.value.strip()
        spec = _SETTING_DEFS.get(key, {})
        for env_key in spec.get("env_fallback", ()):
            val = os.environ.get(env_key)
            if val and val.strip():
                return val.strip()
        return spec.get("default")

    def set(self, key: str, value: str) -> None:
        row = self.db.scalar(select(AppSetting).where(AppSetting.key == key))
        if row:
            row.value = value
        else:
            self.db.add(AppSetting(key=key, value=value))
        self.db.commit()

    def delete(self, key: str) -> None:
        row = self.db.scalar(select(AppSetting).where(AppSetting.key == key))
        if row:
            self.db.delete(row)
            self.db.commit()

    @staticmethod
    def mask_secret(value: str) -> str:
        if not value:
            return ""
        if len(value) <= 8:
            return "••••••••"
        return f"{value[:4]}…{value[-4:]}"

    def gemini_status(self) -> GeminiConfigStatus:
        row = self.db.scalar(select(AppSetting).where(AppSetting.key == "gemini_api_key"))
        db_key = row.value.strip() if row and row.value else ""
        env_key = (
            os.environ.get("GEMINI_API_KEY", "").strip()
            or os.environ.get("GOOGLE_API_KEY", "").strip()
        )
        active = db_key or env_key
        if db_key:
            source = "db"
        elif env_key:
            source = "env"
        else:
            source = "none"
        model = self.get("gemini_model") or DEFAULT_GEMINI_MODEL
        return GeminiConfigStatus(
            configured=bool(active),
            masked=self.mask_secret(active) if active else None,
            model=model,
            source=source,
        )

    def public_config(self) -> dict:
        """Safe-to-display config for the frontend (secrets masked)."""
        gemini = self.gemini_status()
        from services.ai.gemini_config import GeminiLLMConfig, PROMPT_VERSION, CATEGORY_VERSION
        llm_cfg = GeminiLLMConfig.from_db(self.db)
        gemini_llm = llm_cfg.public_dict() if llm_cfg else {
            "model": gemini.model,
            "requests_per_minute": 10,
            "tokens_per_minute": 250_000,
            "delay_between_requests_ms": 2000,
            "max_retries": 3,
            "retry_backoff_base_s": 2.0,
            "batch_size": 20,
            "temperature": 0.1,
            "max_output_tokens": 4096,
            "prompt_version": PROMPT_VERSION,
            "category_version": CATEGORY_VERSION,
        }
        return {
            "gemini": {
                "configured": gemini.configured,
                "masked": gemini.masked,
                "model": gemini.model,
                "source": gemini.source,
            },
            "ai_categorization_enabled": gemini.configured,
            "gemini_models": GEMINI_MODEL_OPTIONS,
            "default_gemini_model": DEFAULT_GEMINI_MODEL,
            "gemini_llm": gemini_llm,
        }

    def update_config(
        self,
        *,
        gemini_api_key: Optional[str] = None,
        gemini_model: Optional[str] = None,
        clear_gemini_api_key: bool = False,
        gemini_rpm: Optional[int] = None,
        gemini_tpm: Optional[int] = None,
        gemini_delay_ms: Optional[int] = None,
        gemini_max_retries: Optional[int] = None,
        gemini_retry_backoff_s: Optional[float] = None,
        gemini_batch_size: Optional[int] = None,
        gemini_temperature: Optional[float] = None,
        gemini_max_output_tokens: Optional[int] = None,
    ) -> dict:
        if clear_gemini_api_key:
            self.delete("gemini_api_key")
        elif gemini_api_key is not None and gemini_api_key.strip():
            self.set("gemini_api_key", gemini_api_key.strip())
        if gemini_model is not None and gemini_model.strip():
            self.set("gemini_model", gemini_model.strip())
        for key, val in [
            ("gemini_rpm", gemini_rpm),
            ("gemini_tpm", gemini_tpm),
            ("gemini_delay_ms", gemini_delay_ms),
            ("gemini_max_retries", gemini_max_retries),
            ("gemini_batch_size", gemini_batch_size),
            ("gemini_max_output_tokens", gemini_max_output_tokens),
        ]:
            if val is not None:
                self.set(key, str(val))
        if gemini_retry_backoff_s is not None:
            self.set("gemini_retry_backoff_s", str(gemini_retry_backoff_s))
        if gemini_temperature is not None:
            self.set("gemini_temperature", str(gemini_temperature))
        return self.public_config()
