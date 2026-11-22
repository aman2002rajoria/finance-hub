"""Central Gemini LLM configuration — loaded from app_settings / env."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

from services.app_config_service import AppConfigService, DEFAULT_GEMINI_MODEL

# Bump when prompt or taxonomy changes.
PROMPT_VERSION = "v4"
CATEGORY_VERSION = "blinkit-6cat-v2"


@dataclass(frozen=True)
class GeminiLLMConfig:
    api_key: str
    model: str = DEFAULT_GEMINI_MODEL
    requests_per_minute: int = 10
    tokens_per_minute: int = 250_000
    delay_between_requests_ms: int = 2000
    max_retries: int = 3
    retry_backoff_base_s: float = 2.0
    batch_size: int = 20
    temperature: float = 0.1
    max_output_tokens: int = 4096
    request_timeout_s: int = 90

    @classmethod
    def from_db(cls, db: "Session") -> "GeminiLLMConfig | None":
        svc = AppConfigService(db)
        api_key = svc.get("gemini_api_key")
        if not api_key:
            return None

        def _int(key: str, default: int) -> int:
            raw = svc.get(key)
            try:
                return int(raw) if raw else default
            except ValueError:
                return default

        def _float(key: str, default: float) -> float:
            raw = svc.get(key)
            try:
                return float(raw) if raw else default
            except ValueError:
                return default

        return cls(
            api_key=api_key,
            model=svc.get("gemini_model") or DEFAULT_GEMINI_MODEL,
            requests_per_minute=_int("gemini_rpm", 10),
            tokens_per_minute=_int("gemini_tpm", 250_000),
            delay_between_requests_ms=_int("gemini_delay_ms", 2000),
            max_retries=_int("gemini_max_retries", 3),
            retry_backoff_base_s=_float("gemini_retry_backoff_s", 2.0),
            batch_size=_int("gemini_batch_size", 20),
            temperature=_float("gemini_temperature", 0.1),
            max_output_tokens=_int("gemini_max_output_tokens", 4096),
            request_timeout_s=_int("gemini_request_timeout_s", 90),
        )

    def public_dict(self) -> dict:
        return {
            "model": self.model,
            "requests_per_minute": self.requests_per_minute,
            "tokens_per_minute": self.tokens_per_minute,
            "delay_between_requests_ms": self.delay_between_requests_ms,
            "max_retries": self.max_retries,
            "retry_backoff_base_s": self.retry_backoff_base_s,
            "batch_size": self.batch_size,
            "temperature": self.temperature,
            "max_output_tokens": self.max_output_tokens,
            "prompt_version": PROMPT_VERSION,
            "category_version": CATEGORY_VERSION,
        }
