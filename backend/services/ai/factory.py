"""Factory for LLM providers."""

from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from services.ai.gemini_config import GeminiLLMConfig
from services.ai.gemini_provider import GeminiProvider


def get_llm_provider(db: Session) -> Optional[GeminiProvider]:
    config = GeminiLLMConfig.from_db(db)
    if not config:
        return None
    return GeminiProvider(config)
