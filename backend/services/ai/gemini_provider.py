"""Gemini LLM provider with rate limiting, retries, and token tracking."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Callable, Dict, List, Optional, Tuple

from services.ai.gemini_config import GeminiLLMConfig
from services.ai.rate_limiter import RateLimiter, parse_retry_after_seconds
from services.ai.types import CategorizeBatchResult, ProviderRequestMetrics, TokenUsage
from services.blinkit_taxonomy import (
    DEFAULT_CATEGORY,
    DEFAULT_SUBCATEGORY,
    classify_by_rules,
    resolve_to_valid_pair,
    taxonomy_prompt,
)


class GeminiProvider:
    """Gemini REST provider — implements LLMProvider protocol."""

    def __init__(self, config: GeminiLLMConfig):
        self.config = config
        self._limiter = RateLimiter(
            requests_per_minute=config.requests_per_minute,
            tokens_per_minute=config.tokens_per_minute,
            min_delay_ms=config.delay_between_requests_ms,
        )
        self.metrics = ProviderRequestMetrics()

    @property
    def model_name(self) -> str:
        return self.config.model

    def test_connection(self) -> Tuple[bool, str]:
        body = {
            "contents": [{"parts": [{"text": "Reply with exactly: OK"}]}],
            "generationConfig": {"temperature": 0, "maxOutputTokens": 16},
        }
        try:
            payload, _ = self._raw_request(body, estimated_tokens=20)
            text = self._extract_text(payload)
            return (True, "Connection successful") if text else (False, "Empty response")
        except Exception as exc:
            return False, str(exc)

    def categorize_batch(
        self,
        products: List[str],
        *,
        cancel_check: Optional[Callable[[], bool]] = None,
        on_phase: Optional[Callable[[str], None]] = None,
    ) -> CategorizeBatchResult:
        unique = list(dict.fromkeys(p.strip() for p in products if p and p.strip()))
        if not unique:
            return CategorizeBatchResult()

        prompt = taxonomy_prompt()
        product_list = "\n".join(f"- {p}" for p in unique)
        user_text = f"{prompt}\n\nProducts:\n{product_list}"
        estimated = max(200, len(user_text) // 4)

        result = CategorizeBatchResult()
        parsed: Dict[str, Tuple[str, str]] = {}
        retries = 0

        for attempt in range(self.config.max_retries + 1):
            if cancel_check and cancel_check():
                result.cancelled = True
                return result

            try:
                if attempt > 0:
                    retries += 1
                    result.retries += 1
                    self.metrics.retries += 1
                    if on_phase:
                        on_phase("retrying")

                if on_phase:
                    on_phase("waiting_rate_limit" if attempt == 0 else "retrying")
                wait_s = self._limiter.wait_if_needed(estimated)
                if wait_s > 0:
                    result.rate_limit_waits += 1
                    self.metrics.rate_limit_waits += 1
                    if on_phase:
                        on_phase("waiting_rate_limit")
                    if not self._sleep_interruptible(wait_s, cancel_check):
                        result.cancelled = True
                        return result

                if cancel_check and cancel_check():
                    result.cancelled = True
                    return result

                if on_phase:
                    on_phase("categorizing")

                self.metrics.requests_sent += 1
                body = {
                    "contents": [{"parts": [{"text": user_text}]}],
                    "generationConfig": {
                        "temperature": self.config.temperature,
                        "maxOutputTokens": self.config.max_output_tokens,
                    },
                }
                payload, usage = self._raw_request(body, estimated_tokens=estimated)
                self._limiter.record(usage.total_tokens or estimated)
                self.metrics.tokens.add(usage)
                result.tokens.add(usage)

                text = self._extract_text(payload)
                parsed = self._parse_response(text, unique)
                if parsed:
                    self.metrics.requests_ok += 1
                    break

                if attempt < self.config.max_retries:
                    user_text = (
                        f"{user_text}\n\nYour previous response was invalid JSON. "
                        "Return ONLY a valid JSON array."
                    )
                    continue
                result.error_message = "Gemini returned invalid or unparseable JSON"
                self.metrics.requests_failed += 1

            except urllib.error.HTTPError as exc:
                self.metrics.requests_failed += 1
                msg = self._http_error_message(exc)
                result.error_message = msg
                result.error_code = exc.code
                if exc.code == 429 and attempt < self.config.max_retries:
                    retries += 1
                    result.retries += 1
                    self.metrics.retries += 1
                    result.rate_limit_waits += 1
                    self.metrics.rate_limit_waits += 1
                    delay = parse_retry_after_seconds(msg) or (
                        self.config.retry_backoff_base_s * (2 ** attempt)
                    )
                    import time
                    if on_phase:
                        on_phase("waiting_rate_limit")
                    if not self._sleep_interruptible(delay, cancel_check):
                        result.cancelled = True
                        return result
                    continue
                if attempt < self.config.max_retries:
                    import time
                    if on_phase:
                        on_phase("retrying")
                    if not self._sleep_interruptible(
                        self.config.retry_backoff_base_s * (2 ** attempt),
                        cancel_check,
                    ):
                        result.cancelled = True
                        return result
                    continue
                result.failed_products = unique
                return result

            except Exception as exc:
                self.metrics.requests_failed += 1
                result.error_message = str(exc)
                if attempt < self.config.max_retries:
                    if on_phase:
                        on_phase("retrying")
                    if not self._sleep_interruptible(
                        self.config.retry_backoff_base_s * (2 ** attempt),
                        cancel_check,
                    ):
                        result.cancelled = True
                        return result
                    continue
                result.failed_products = unique
                return result

        result.products = parsed
        result.retries = retries
        missing = [p for p in unique if p not in parsed]
        if missing and len(parsed) > 0:
            for name in missing:
                if cancel_check and cancel_check():
                    result.cancelled = True
                    return result
                single = self.categorize_batch([name], cancel_check=cancel_check, on_phase=on_phase)
                if single.cancelled:
                    result.cancelled = True
                    return result
                result.products.update(single.products)
                result.failed_products.extend(single.failed_products)
                result.tokens.add(single.tokens)
                result.retries += single.retries
                result.rate_limit_waits += single.rate_limit_waits
        elif missing:
            result.failed_products = missing
            if not result.error_message:
                result.error_message = (
                    f"Gemini response missing {len(missing)} of {len(unique)} products"
                )
        return result

    @staticmethod
    def _sleep_interruptible(
        seconds: float,
        cancel_check: Optional[Callable[[], bool]],
        *,
        chunk_s: float = 0.5,
    ) -> bool:
        """Sleep up to ``seconds``. Returns False if cancelled."""
        import time
        remaining = max(0.0, seconds)
        while remaining > 0:
            if cancel_check and cancel_check():
                return False
            step = min(chunk_s, remaining)
            time.sleep(step)
            remaining -= step
        return True

    def _raw_request(
        self, body: dict, *, estimated_tokens: int,
    ) -> Tuple[dict, TokenUsage]:
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.config.model}:generateContent?key={self.config.api_key}"
        )
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.config.request_timeout_s) as resp:
            payload = json.loads(resp.read().decode())
        usage = self._extract_usage(payload, estimated_tokens)
        return payload, usage

    @staticmethod
    def _extract_text(payload: dict) -> str:
        return (
            payload.get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text", "")
        )

    @staticmethod
    def _extract_usage(payload: dict, estimated: int) -> TokenUsage:
        meta = payload.get("usageMetadata") or {}
        inp = int(meta.get("promptTokenCount") or 0)
        out = int(meta.get("candidatesTokenCount") or 0)
        total = int(meta.get("totalTokenCount") or (inp + out))
        if total > 0:
            return TokenUsage(input_tokens=inp, output_tokens=out, total_tokens=total, estimated=False)
        return TokenUsage(
            input_tokens=estimated,
            output_tokens=max(50, estimated // 10),
            total_tokens=estimated + max(50, estimated // 10),
            estimated=True,
        )

    @staticmethod
    def _http_error_message(exc: urllib.error.HTTPError) -> str:
        try:
            detail = json.loads(exc.read().decode())
            return detail.get("error", {}).get("message", str(exc))
        except Exception:
            return str(exc)

    @staticmethod
    def _parse_response(text: str, products: List[str]) -> Dict[str, Tuple[str, str]]:
        out: Dict[str, Tuple[str, str]] = {}
        if not text:
            return out
        match = re.search(r"\[[\s\S]*\]", text)
        if not match:
            return out
        try:
            rows = json.loads(match.group())
        except json.JSONDecodeError:
            return out
        lookup = {p.lower(): p for p in products}
        # Fuzzy fallback: match when LLM truncates or slightly rewrites the name
        for row in rows:
            if not isinstance(row, dict):
                continue
            name = str(row.get("product", "")).strip()
            cat = str(row.get("category", DEFAULT_CATEGORY)).strip()
            sub = str(row.get("subcategory", DEFAULT_SUBCATEGORY)).strip()
            cat, sub = resolve_to_valid_pair(cat, sub)
            if cat == DEFAULT_CATEGORY and sub == DEFAULT_SUBCATEGORY:
                ruled = classify_by_rules(name)
                if ruled:
                    cat, sub = ruled
            key = lookup.get(name.lower())
            if not key and name:
                nl = name.lower()
                for pk, orig in lookup.items():
                    if pk in nl or nl in pk:
                        key = orig
                        break
            if key:
                if cat == DEFAULT_CATEGORY and sub == DEFAULT_SUBCATEGORY:
                    ruled = classify_by_rules(key)
                    if ruled:
                        cat, sub = ruled
                out[key] = (cat, sub)
        return out
