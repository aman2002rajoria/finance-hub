"""Token-bucket style rate limiter for LLM API calls."""

from __future__ import annotations

import re
import threading
import time
from collections import deque
from typing import Optional


class RateLimiter:
    """Respect RPM/TPM limits with optional minimum delay between requests."""

    def __init__(
        self,
        *,
        requests_per_minute: int = 10,
        tokens_per_minute: int = 250_000,
        min_delay_ms: int = 2000,
    ):
        self.rpm = max(1, requests_per_minute)
        self.tpm = max(1000, tokens_per_minute)
        self.min_delay_s = max(0, min_delay_ms) / 1000.0
        self._lock = threading.Lock()
        self._request_times: deque[float] = deque()
        self._token_events: deque[tuple[float, int]] = deque()
        self._last_request_at: float = 0.0
        self.rate_limit_waits = 0

    def wait_if_needed(self, estimated_tokens: int = 500) -> float:
        """Block until a request is allowed. Returns seconds waited."""
        waited = 0.0
        while True:
            with self._lock:
                now = time.monotonic()
                self._prune(now)
                wait_s = self._compute_wait(now, estimated_tokens)
                if wait_s <= 0:
                    if self.min_delay_s > 0 and self._last_request_at > 0:
                        gap = self.min_delay_s - (now - self._last_request_at)
                        if gap > 0:
                            wait_s = gap
                        else:
                            return waited
                    else:
                        return waited
            if wait_s > 0:
                self.rate_limit_waits += 1
                time.sleep(wait_s)
                waited += wait_s
            else:
                return waited

    def record(self, tokens_used: int) -> None:
        with self._lock:
            now = time.monotonic()
            self._request_times.append(now)
            self._token_events.append((now, max(1, tokens_used)))
            self._last_request_at = now

    def _prune(self, now: float) -> None:
        cutoff = now - 60.0
        while self._request_times and self._request_times[0] < cutoff:
            self._request_times.popleft()
        while self._token_events and self._token_events[0][0] < cutoff:
            self._token_events.popleft()

    def _compute_wait(self, now: float, estimated_tokens: int) -> float:
        if len(self._request_times) >= self.rpm:
            oldest = self._request_times[0]
            rpm_wait = 60.0 - (now - oldest) + 0.05
            if rpm_wait > 0:
                return rpm_wait
        token_sum = sum(t for _, t in self._token_events) + estimated_tokens
        if token_sum > self.tpm and self._token_events:
            oldest = self._token_events[0][0]
            tpm_wait = 60.0 - (now - oldest) + 0.05
            if tpm_wait > 0:
                return tpm_wait
        return 0.0


def parse_retry_after_seconds(message: str) -> Optional[float]:
    """Extract retry delay from Gemini 429 error messages."""
    m = re.search(r"retry in ([\d.]+)s", message, re.I)
    if m:
        return float(m.group(1))
    m = re.search(r"Retry-After:\s*(\d+)", message, re.I)
    if m:
        return float(m.group(1))
    return None
