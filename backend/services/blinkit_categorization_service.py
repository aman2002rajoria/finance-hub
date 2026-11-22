"""Product categorization with rules + optional LLM, persistent cache.

* **Ingest** (``refresh=False``): only classify product keys not yet cached.
* **Re-categorize** (``refresh=True``): re-run rules for all non-manual products;
  keep existing LLM cache unless rules match.
* **Force re-categorize** (``refresh=True, force_reclassify=True``): re-run LLM
  for all non-manual products (skips keyword rules). Manual categories are never overwritten.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from db.models import BlinkitOrderItem, BlinkitProductCategoryRecord
from services.ai.factory import get_llm_provider
from services.ai.gemini_config import CATEGORY_VERSION, PROMPT_VERSION
from services.blinkit_taxonomy import (
    BLINKIT_TAXONOMY,
    DEFAULT_CATEGORY,
    DEFAULT_SUBCATEGORY,
    PRIMARY_CATEGORIES,
    classify_by_rules,
    is_valid_pair,
    normalize_legacy,
)


def normalize_product_key(product_name: str, upc: Optional[str] = None) -> str:
    if upc and upc.strip():
        return f"upc:{upc.strip()}"
    name = product_name or ""
    name = re.sub(r"\(HSN[-\s]?\d+\)", "", name, flags=re.I)
    name = re.sub(r"\s+", " ", name).strip().lower()
    return f"name:{name[:200]}"


@dataclass
class CategorizationResult:
    products_processed: int = 0
    products_new: int = 0
    items_updated: int = 0
    llm_used: int = 0
    skipped_manual: int = 0
    ai_enabled: bool = False


class BlinkitCategorizationService:
    def __init__(self, db: Session):
        self.db = db

    def categorize_all(
        self,
        *,
        refresh: bool = False,
        force_reclassify: bool = False,
        force: bool = False,
    ) -> CategorizationResult:
        """Classify Blinkit products.

        ``force`` is a backward-compatible alias: when True it sets
        ``refresh=True`` and ``force_reclassify=True``.
        """
        if force:
            refresh = True
            force_reclassify = True

        result = CategorizationResult(ai_enabled=get_llm_provider(self.db) is not None)
        cache = self._load_cache()

        items = self.db.scalars(
            select(BlinkitOrderItem).where(BlinkitOrderItem.line_type == "product")
        ).all()

        key_to_name: Dict[str, str] = {}
        for item in items:
            key = normalize_product_key(item.product_name, item.upc)
            key_to_name.setdefault(key, item.product_name)

        needs_llm: List[str] = []
        key_to_pair: Dict[str, Tuple[str, str]] = {}

        for key, name in key_to_name.items():
            entry = cache.get(key)

            if entry and entry[2] == "manual":
                key_to_pair[key] = (entry[0], entry[1])
                result.skipped_manual += 1
                continue

            if not refresh and entry:
                key_to_pair[key] = (entry[0], entry[1])
                continue

            if force_reclassify:
                needs_llm.append(name)
                continue

            ruled = classify_by_rules(name)
            if ruled:
                key_to_pair[key] = ruled
                self._upsert_cache(key, name, ruled[0], ruled[1], "rules", result)
                continue

            if entry and not force_reclassify:
                cat, sub, source = entry
                if is_valid_pair(cat, sub) and source in ("llm", "rules"):
                    key_to_pair[key] = (cat, sub)
                    continue

            needs_llm.append(name)

        if needs_llm and get_llm_provider(self.db):
            provider = get_llm_provider(self.db)
            unique_names = list(dict.fromkeys(needs_llm))
            batch_size = provider.config.batch_size if provider else 20
            for i in range(0, len(unique_names), batch_size):
                batch = unique_names[i:i + batch_size]
                llm_results = provider.categorize_batch(batch).products if provider else {}
                result.llm_used += len(llm_results)
                for name in batch:
                    key = normalize_product_key(name)
                    if key in key_to_pair:
                        continue
                    pair = llm_results.get(name)
                    if pair:
                        key_to_pair[key] = pair
                        self._upsert_cache(key, name, pair[0], pair[1], "llm", result)
                    else:
                        key_to_pair[key] = (DEFAULT_CATEGORY, DEFAULT_SUBCATEGORY)
                        self._upsert_cache(
                            key, name, DEFAULT_CATEGORY, DEFAULT_SUBCATEGORY, "rules", result,
                        )

        for name in needs_llm:
            key = normalize_product_key(name)
            if key not in key_to_pair:
                key_to_pair[key] = (DEFAULT_CATEGORY, DEFAULT_SUBCATEGORY)
                self._upsert_cache(
                    key, name, DEFAULT_CATEGORY, DEFAULT_SUBCATEGORY, "rules", result,
                )

        for item in items:
            key = normalize_product_key(item.product_name, item.upc)
            entry = cache.get(key)
            if entry and entry[2] == "manual":
                cat, sub = entry[0], entry[1]
            else:
                cat, sub = key_to_pair.get(key) or (
                    (entry[0], entry[1]) if entry else (DEFAULT_CATEGORY, DEFAULT_SUBCATEGORY)
                )
            if not is_valid_pair(cat, sub):
                cat, sub = normalize_legacy(cat, sub)

            if item.category != cat or getattr(item, "subcategory", None) != sub:
                item.category = cat
                item.subcategory = sub
                result.items_updated += 1

        self.db.commit()
        result.products_processed = len(key_to_name)
        return result

    def get_category(self, product_name: str, upc: Optional[str] = None) -> Tuple[str, str]:
        key = normalize_product_key(product_name, upc)
        row = self.db.scalar(
            select(BlinkitProductCategoryRecord).where(
                BlinkitProductCategoryRecord.product_key == key,
            )
        )
        if row:
            return row.category, row.subcategory or DEFAULT_SUBCATEGORY
        ruled = classify_by_rules(product_name)
        if ruled:
            cat, sub = ruled
            source = "rules"
        else:
            cat, sub = DEFAULT_CATEGORY, DEFAULT_SUBCATEGORY
            source = "rules"
        self.db.add(BlinkitProductCategoryRecord(
            product_key=key,
            product_name=product_name[:500],
            category=cat,
            subcategory=sub,
            source=source,
        ))
        self.db.commit()
        return cat, sub

    def _upsert_cache(
        self,
        key: str,
        name: str,
        category: str,
        subcategory: str,
        source: str,
        result: CategorizationResult,
    ) -> None:
        existing = self.db.scalar(
            select(BlinkitProductCategoryRecord).where(
                BlinkitProductCategoryRecord.product_key == key,
            )
        )
        if existing:
            if existing.source == "manual":
                return
            existing.category = category
            existing.subcategory = subcategory
            existing.product_name = name[:500]
            if source == "llm" or existing.source != "llm":
                existing.source = source
            if source == "llm":
                existing.ai_categorized = True
                existing.ai_model = get_llm_provider(self.db).model_name if get_llm_provider(self.db) else None
                existing.ai_categorized_at = datetime.now(timezone.utc).replace(tzinfo=None)
                existing.prompt_version = PROMPT_VERSION
                existing.category_version = CATEGORY_VERSION
            elif source == "rules":
                existing.ai_categorized = False
        else:
            row_kwargs = dict(
                product_key=key,
                product_name=name[:500],
                category=category,
                subcategory=subcategory,
                source=source,
            )
            if source == "llm":
                provider = get_llm_provider(self.db)
                row_kwargs.update(
                    ai_categorized=True,
                    ai_model=provider.model_name if provider else None,
                    ai_categorized_at=datetime.now(timezone.utc).replace(tzinfo=None),
                    prompt_version=PROMPT_VERSION,
                    category_version=CATEGORY_VERSION,
                )
            self.db.add(BlinkitProductCategoryRecord(**row_kwargs))
            result.products_new += 1

    def _load_cache(self) -> Dict[str, Tuple[str, str, str]]:
        """product_key → (category, subcategory, source)"""
        rows = self.db.scalars(select(BlinkitProductCategoryRecord)).all()
        out: Dict[str, Tuple[str, str, str]] = {}
        for r in rows:
            cat, sub = normalize_legacy(r.category, r.subcategory)
            out[r.product_key] = (cat, sub, r.source or "rules")
        return out

    @staticmethod
    def all_categories() -> List[str]:
        return PRIMARY_CATEGORIES

    @staticmethod
    def all_subcategories(primary: Optional[str] = None) -> List[str]:
        if primary and primary in BLINKIT_TAXONOMY:
            return BLINKIT_TAXONOMY[primary]
        subs: List[str] = []
        for s in BLINKIT_TAXONOMY.values():
            subs.extend(s)
        return sorted(set(subs))
