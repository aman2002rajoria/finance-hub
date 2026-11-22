"""Shared types for LLM categorization providers."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Protocol, Tuple


@dataclass
class TokenUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    estimated: bool = False

    def add(self, other: "TokenUsage") -> None:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.total_tokens += other.total_tokens


@dataclass
class CategorizeBatchResult:
    """Result of classifying one batch of product names."""
    products: Dict[str, Tuple[str, str]] = field(default_factory=dict)
    failed_products: List[str] = field(default_factory=list)
    tokens: TokenUsage = field(default_factory=TokenUsage)
    retries: int = 0
    rate_limit_waits: int = 0
    error_message: Optional[str] = None
    error_code: Optional[int] = None
    cancelled: bool = False


@dataclass
class ProviderRequestMetrics:
    requests_sent: int = 0
    requests_ok: int = 0
    requests_failed: int = 0
    retries: int = 0
    rate_limit_waits: int = 0
    tokens: TokenUsage = field(default_factory=TokenUsage)


class LLMProvider(Protocol):
    """Provider-agnostic interface — swap Gemini for OpenAI/Claude later."""

    @property
    def model_name(self) -> str: ...

    def categorize_batch(self, products: List[str]) -> CategorizeBatchResult: ...

    def test_connection(self) -> Tuple[bool, str]: ...
