"""Orchestrates Blinkit product categorization with progress, rate limits, and resume."""

from __future__ import annotations

import threading
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from db.database import SessionLocal
from db.models import BlinkitOrderItem, BlinkitProductCategoryRecord
from services.ai.factory import get_llm_provider
from services.ai.gemini_config import CATEGORY_VERSION, PROMPT_VERSION
from services.blinkit_taxonomy import (
    DEFAULT_CATEGORY,
    DEFAULT_SUBCATEGORY,
    classify_by_rules,
    is_valid_pair,
    normalize_legacy,
)
from services.blinkit_categorization_service import normalize_product_key
from services.categorization_job_manager import CategorizationJob, CategorizationJobManager


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class BlinkitCategorizationEngine:
    """Runs categorization jobs with live progress and resumable batch commits."""

    def __init__(self, db: Session, job: CategorizationJob):
        self.db = db
        self.job = job
        self.provider = get_llm_provider(db)

    @staticmethod
    def start_job(mode: str) -> CategorizationJob:
        mgr = CategorizationJobManager.instance()
        job = mgr.create_job(mode)
        thread = threading.Thread(
            target=_run_job_thread,
            args=(job.job_id, mode),
            daemon=True,
        )
        thread.start()
        return job

    def run(self) -> None:
        self.job.status = "running"
        self.job.set_phase("preparing")
        self.job.log("Loading distinct products from invoice data...")
        if self.provider:
            self.job.ai_model = self.provider.model_name

        items = self.db.scalars(
            select(BlinkitOrderItem).where(BlinkitOrderItem.line_type == "product")
        ).all()

        key_to_name: Dict[str, str] = {}
        for item in items:
            key = normalize_product_key(item.product_name, item.upc)
            key_to_name.setdefault(key, item.product_name)

        cache = self._load_cache()
        to_process: List[Tuple[str, str]] = []  # (key, name)

        force_ai = self.job.mode == "reclassify_all"

        for key, name in key_to_name.items():
            entry = cache.get(key)
            if entry and entry.get("source") == "manual":
                self.job.summary.already_skipped += 1
                continue

            if force_ai:
                if not self.provider:
                    ruled = classify_by_rules(name)
                    if ruled:
                        self._save_rules(key, name, ruled[0], ruled[1])
                        self.job.summary.rules_categorized += 1
                    else:
                        self._save_rules(key, name, DEFAULT_CATEGORY, DEFAULT_SUBCATEGORY)
                    continue
                to_process.append((key, name))
                continue

            ruled = classify_by_rules(name)
            if ruled:
                self._save_rules(key, name, ruled[0], ruled[1])
                self.job.summary.rules_categorized += 1
                continue

            if entry and entry.get("ai_categorized"):
                self.job.summary.already_skipped += 1
                continue

            if not self.provider:
                self._save_rules(key, name, DEFAULT_CATEGORY, DEFAULT_SUBCATEGORY)
                continue

            to_process.append((key, name))

        self.job.total_products = len(to_process)
        self.job.log(f"Found {len(key_to_name)} distinct products.")
        if force_ai:
            skipped = self.job.summary.already_skipped
            self.job.log(
                f"Re-categorize All: {len(to_process)} queued for AI"
                + (f" ({skipped} manual skipped)" if skipped else "")
                + "."
            )
        else:
            self.job.log(
                f"{self.job.summary.rules_categorized} classified by rules, "
                f"{len(to_process)} need AI."
            )

        if not to_process:
            self.job.log(
                "No products to categorize — applying existing categories to line items..."
                if force_ai
                else "No AI calls needed — applying rule-based categories to line items..."
            )
            self.db.commit()
            self._apply_to_line_items(items)
            self.db.commit()
            self._finish()
            return

        if not self.provider:
            self.job.log("AI not configured — applying rule-based categories only.")
            self.db.commit()
            self._apply_to_line_items(items)
            self.db.commit()
            self._finish()
            return

        batch_size = self.provider.config.batch_size
        names_only = [name for _, name in to_process]
        batches: List[List[str]] = []
        for i in range(0, len(names_only), batch_size):
            batches.append(names_only[i:i + batch_size])

        self.job.total_batches = len(batches)
        name_to_key = {name: key for key, name in to_process}
        self.job.set_phase("categorizing")

        for batch_idx, batch in enumerate(batches, start=1):
            if self._is_cancelled():
                self._handle_cancel(items)
                return

            self.job.current_batch = batch_idx
            self.job.set_phase("categorizing")
            self.job.log(f"Preparing batch {batch_idx} of {len(batches)} ({len(batch)} products)...")
            self.job.log("Sending request to Gemini...")
            result = self.provider.categorize_batch(
                batch,
                cancel_check=self._is_cancelled,
                on_phase=self._on_provider_phase,
            )
            if result.cancelled:
                self._handle_cancel(items)
                return
            if result.rate_limit_waits > 0:
                self.job.log(f"Waiting due to rate limit (batch {batch_idx})...")
            self.job.log("Received Gemini response — saving categorized products...")

            self._merge_metrics(result)

            if result.error_message:
                affected = len(result.failed_products) or len(batch)
                self.job.record_api_error(
                    batch=batch_idx,
                    code=result.error_code,
                    message=result.error_message,
                    products_affected=affected,
                )
            elif result.failed_products and not result.products:
                self.job.record_api_error(
                    batch=batch_idx,
                    code=None,
                    message="Invalid or empty JSON response from Gemini after retries",
                    products_affected=len(result.failed_products),
                )

            for name in batch:
                key = name_to_key.get(name, normalize_product_key(name))
                pair = result.products.get(name)
                if pair:
                    had_category = bool(cache.get(key))
                    self._save_ai(key, name, pair[0], pair[1])
                    if force_ai or had_category:
                        self.job.summary.recategorized += 1
                    else:
                        self.job.summary.newly_categorized += 1
                elif name in result.failed_products:
                    self.job.failed_products.append(name)
                    self.job.summary.failed += 1
                    if not result.error_message:
                        self.job.log(f"No category returned for: {name[:50]}")
                else:
                    self._save_rules(key, name, DEFAULT_CATEGORY, DEFAULT_SUBCATEGORY)

                self.job.completed_products += 1
                self.job.summary.total_processed += 1

            self.db.commit()
            self.job.log(f"Saved batch {batch_idx} — {self.job.completed_products}/{self.job.total_products} products.")

            if self._is_cancelled():
                self._handle_cancel(items)
                return

        self.job.log("Applying categories to invoice line items...")
        self._apply_to_line_items(items)
        self.db.commit()
        self._finish()

    def _is_cancelled(self) -> bool:
        return bool(getattr(self.job, "cancel_requested", False))

    def _on_provider_phase(self, phase: str) -> None:
        if self._is_cancelled():
            self.job.set_phase("cancelling")
        else:
            self.job.set_phase(phase)

    def _handle_cancel(self, items: List[BlinkitOrderItem]) -> None:
        self.job.set_phase("cancelling")
        self.job.log("Stopping categorization — saving progress so far...")
        self._apply_to_line_items(items)
        self.db.commit()
        self.job.status = "cancelled"
        self.job.set_phase("cancelled")
        self.job.finished_at = __import__("time").time()
        self.job.log("Categorization cancelled.")
        CategorizationJobManager.instance().complete(self.job.job_id)

    def _merge_metrics(self, result) -> None:
        m = self.job.metrics
        pm = self.provider.metrics if self.provider else None
        if pm:
            m.requests_sent = pm.requests_sent
            m.requests_ok = pm.requests_ok
            m.requests_failed = pm.requests_failed
            m.retries = pm.retries
            m.rate_limit_waits = pm.rate_limit_waits
            m.input_tokens = pm.tokens.input_tokens
            m.output_tokens = pm.tokens.output_tokens
            m.total_tokens = pm.tokens.total_tokens
            m.tokens_estimated = pm.tokens.estimated

    def _save_rules(self, key: str, name: str, cat: str, sub: str) -> None:
        row = self._get_or_create(key, name)
        row.category = cat
        row.subcategory = sub
        row.source = "rules"
        row.ai_categorized = False
        row.updated_at = _utcnow()

    def _save_ai(self, key: str, name: str, cat: str, sub: str) -> None:
        row = self._get_or_create(key, name)
        row.category = cat
        row.subcategory = sub
        row.source = "llm"
        row.ai_categorized = True
        row.ai_model = self.provider.model_name if self.provider else None
        row.ai_categorized_at = _utcnow()
        row.prompt_version = PROMPT_VERSION
        row.category_version = CATEGORY_VERSION
        row.updated_at = _utcnow()

    def _get_or_create(self, key: str, name: str) -> BlinkitProductCategoryRecord:
        row = self.db.scalar(
            select(BlinkitProductCategoryRecord).where(
                BlinkitProductCategoryRecord.product_key == key,
            )
        )
        if row:
            row.product_name = name[:500]
            return row
        row = BlinkitProductCategoryRecord(
            product_key=key,
            product_name=name[:500],
            category=DEFAULT_CATEGORY,
            subcategory=DEFAULT_SUBCATEGORY,
            source="rules",
        )
        self.db.add(row)
        return row

    def _apply_to_line_items(self, items: List[BlinkitOrderItem]) -> None:
        self.db.flush()
        cache = self._load_cache()
        for item in items:
            key = normalize_product_key(item.product_name, item.upc)
            entry = cache.get(key)
            if not entry:
                continue
            if entry.get("source") == "manual":
                cat, sub = entry["category"], entry["subcategory"]
            else:
                cat, sub = entry["category"], entry["subcategory"]
            if not is_valid_pair(cat, sub):
                cat, sub = normalize_legacy(cat, sub)
            if item.category != cat or getattr(item, "subcategory", None) != sub:
                item.category = cat
                item.subcategory = sub
                self.job.summary.items_updated += 1

    def _load_cache(self) -> Dict[str, dict]:
        rows = self.db.scalars(select(BlinkitProductCategoryRecord)).all()
        out: Dict[str, dict] = {}
        for r in rows:
            cat, sub = normalize_legacy(r.category, r.subcategory)
            out[r.product_key] = {
                "category": cat,
                "subcategory": sub,
                "source": r.source or "rules",
                "ai_categorized": bool(getattr(r, "ai_categorized", False)),
            }
        return out

    def _finish(self) -> None:
        self.job.status = "completed"
        self.job.set_phase("completed")
        self.job.finished_at = __import__("time").time()
        self.job.log("Categorization completed successfully.")
        CategorizationJobManager.instance().complete(self.job.job_id)


def _run_job_thread(job_id: str, mode: str) -> None:
    mgr = CategorizationJobManager.instance()
    job = mgr.get(job_id)
    if not job:
        return
    db = SessionLocal()
    try:
        BlinkitCategorizationEngine(db, job).run()
    except Exception as exc:
        job.status = "failed"
        job.set_phase("failed")
        job.error = str(exc)
        job.finished_at = __import__("time").time()
        job.log(f"Error: {exc}")
        mgr.complete(job_id)
    finally:
        db.close()
