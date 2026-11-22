"""In-memory job state for categorization progress tracking."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ApiErrorEntry:
    """One recorded API failure during categorization."""
    batch: int
    code: Optional[int]
    message: str
    timestamp: str
    products_affected: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class JobMetrics:
    requests_sent: int = 0
    requests_ok: int = 0
    requests_failed: int = 0
    retries: int = 0
    rate_limit_waits: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    tokens_estimated: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class JobSummary:
    total_processed: int = 0
    newly_categorized: int = 0
    already_skipped: int = 0
    recategorized: int = 0
    failed: int = 0
    items_updated: int = 0
    rules_categorized: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class CategorizationJob:
    job_id: str
    mode: str  # unclassified | reclassify_all
    status: str = "pending"  # pending | running | completed | failed | cancelled
    phase: str = "preparing"  # preparing | categorizing | waiting_rate_limit | retrying | cancelling
    total_products: int = 0
    completed_products: int = 0
    current_batch: int = 0
    total_batches: int = 0
    activity_log: List[str] = field(default_factory=list)
    metrics: JobMetrics = field(default_factory=JobMetrics)
    summary: JobSummary = field(default_factory=JobSummary)
    failed_products: List[str] = field(default_factory=list)
    failure_reason: Optional[str] = None
    last_api_error: Optional[str] = None
    last_api_error_code: Optional[int] = None
    api_errors: List[ApiErrorEntry] = field(default_factory=list)
    error: Optional[str] = None
    started_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    ai_model: Optional[str] = None
    cancel_requested: bool = False

    def request_cancel(self) -> None:
        self.cancel_requested = True
        self.phase = "cancelling"

    def set_phase(self, phase: str) -> None:
        self.phase = phase

    @property
    def progress_pct(self) -> float:
        if self.total_products <= 0:
            return 0.0
        return round(100.0 * self.completed_products / self.total_products, 1)

    @property
    def elapsed_s(self) -> float:
        end = self.finished_at or time.time()
        return round(end - self.started_at, 1)

    @property
    def eta_s(self) -> Optional[float]:
        if self.completed_products <= 0 or self.status not in ("running", "pending"):
            return None
        rate = self.completed_products / max(0.1, self.elapsed_s)
        remaining = self.total_products - self.completed_products
        return round(remaining / rate, 1) if rate > 0 else None

    @property
    def throughput_per_min(self) -> float:
        if self.elapsed_s <= 0:
            return 0.0
        return round(self.completed_products / (self.elapsed_s / 60.0), 1)

    @property
    def avg_s_per_product(self) -> float:
        if self.completed_products <= 0:
            return 0.0
        return round(self.elapsed_s / self.completed_products, 2)

    def log(self, msg: str) -> None:
        ts = time.strftime("%H:%M:%S")
        line = f"[{ts}] {msg}"
        self.activity_log.append(line)
        if len(self.activity_log) > 200:
            self.activity_log = self.activity_log[-200:]

    def record_api_error(
        self,
        *,
        batch: int,
        code: Optional[int],
        message: str,
        products_affected: int = 0,
    ) -> None:
        """Track an API failure for progress UI and debugging."""
        ts = time.strftime("%H:%M:%S")
        short = (message or "Unknown error").strip()
        entry = ApiErrorEntry(
            batch=batch,
            code=code,
            message=short[:500],
            timestamp=ts,
            products_affected=products_affected,
        )
        self.api_errors.append(entry)
        if len(self.api_errors) > 50:
            self.api_errors = self.api_errors[-50:]

        self.last_api_error = short[:300]
        self.last_api_error_code = code

        if code == 429:
            self.failure_reason = (
                "Gemini API quota exceeded — wait for reset, switch model, or use a paid API key"
            )
        elif not self.failure_reason:
            self.failure_reason = short[:200]

        code_label = f"HTTP {code}" if code else "error"
        self.log(f"API {code_label} (batch {batch}, {products_affected} products): {short[:140]}")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "job_id": self.job_id,
            "mode": self.mode,
            "status": self.status,
            "phase": self.phase,
            "cancel_requested": self.cancel_requested,
            "total_products": self.total_products,
            "completed_products": self.completed_products,
            "progress_pct": self.progress_pct,
            "current_batch": self.current_batch,
            "total_batches": self.total_batches,
            "activity_log": self.activity_log[-80:],
            "metrics": self.metrics.to_dict(),
            "summary": self.summary.to_dict(),
            "failed_products": self.failed_products[:50],
            "failure_reason": self.failure_reason,
            "last_api_error": self.last_api_error,
            "last_api_error_code": self.last_api_error_code,
            "api_errors": [e.to_dict() for e in self.api_errors[-20:]],
            "error": self.error,
            "elapsed_s": self.elapsed_s,
            "eta_s": self.eta_s,
            "throughput_per_min": self.throughput_per_min,
            "avg_s_per_product": self.avg_s_per_product,
            "ai_model": self.ai_model,
        }


class CategorizationJobManager:
    _instance: Optional["CategorizationJobManager"] = None
    _lock = threading.Lock()

    def __init__(self):
        self._jobs: Dict[str, CategorizationJob] = {}
        self._active_job_id: Optional[str] = None

    @classmethod
    def instance(cls) -> "CategorizationJobManager":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    def create_job(self, mode: str) -> CategorizationJob:
        with self._lock:
            if self._active_job_id:
                active = self._jobs.get(self._active_job_id)
                if active and active.status in ("running", "pending"):
                    raise RuntimeError("A categorization job is already running")
            job_id = str(uuid.uuid4())
            job = CategorizationJob(job_id=job_id, mode=mode)
            self._jobs[job_id] = job
            self._active_job_id = job_id
            return job

    def get(self, job_id: str) -> Optional[CategorizationJob]:
        return self._jobs.get(job_id)

    def get_active(self) -> Optional[CategorizationJob]:
        if not self._active_job_id:
            return None
        job = self._jobs.get(self._active_job_id)
        if job and job.status in ("running", "pending"):
            return job
        return None

    def complete(self, job_id: str) -> None:
        with self._lock:
            if self._active_job_id == job_id:
                self._active_job_id = None

    def cancel(self, job_id: Optional[str] = None) -> Optional[CategorizationJob]:
        """Request cancellation of a running job (or the active job if job_id omitted)."""
        with self._lock:
            target_id = job_id or self._active_job_id
            if not target_id:
                return None
            job = self._jobs.get(target_id)
            if not job or job.status not in ("running", "pending"):
                return job
            job.request_cancel()
            job.log("Categorization cancelled by user.")
            return job
