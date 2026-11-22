"""Backward-compatible wrappers — delegates to services.ai."""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from services.ai.factory import get_llm_provider
from services.ai.gemini_config import GeminiLLMConfig
from services.app_config_service import DEFAULT_GEMINI_MODEL


def get_gemini_api_key(db: Optional[Session] = None) -> Optional[str]:
    if db is None:
        return None
    cfg = GeminiLLMConfig.from_db(db)
    return cfg.api_key if cfg else None


def get_gemini_model(db: Optional[Session] = None) -> str:
    if db is None:
        return DEFAULT_GEMINI_MODEL
    cfg = GeminiLLMConfig.from_db(db)
    return cfg.model if cfg else DEFAULT_GEMINI_MODEL


def llm_available(db: Optional[Session] = None) -> bool:
    return get_llm_provider(db) is not None


def test_gemini_connection(api_key: str, model: str) -> Tuple[bool, str]:
    from services.ai.gemini_provider import GeminiProvider
    cfg = GeminiLLMConfig(api_key=api_key, model=model)
    return GeminiProvider(cfg).test_connection()


def categorize_products_batch(
    products: List[str],
    db: Optional[Session] = None,
) -> Dict[str, Tuple[str, str]]:
    provider = get_llm_provider(db) if db else None
    if not provider or not products:
        return {}
    unique = list(dict.fromkeys(p.strip() for p in products if p and p.strip()))
    out: Dict[str, Tuple[str, str]] = {}
    batch_size = provider.config.batch_size
    for i in range(0, len(unique), batch_size):
        batch = unique[i:i + batch_size]
        result = provider.categorize_batch(batch)
        out.update(result.products)
    return out
