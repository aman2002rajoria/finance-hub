"""Business-logic services.

These modules sit between the bank-specific PDF parsers (``parsers/``)
and the FastAPI route handlers (``api/``). They are deliberately
framework-agnostic — no FastAPI imports — so they can be reused from
scripts, tests, and the future scheduler.
"""

from services.dedup_service import deterministic_txn_id, file_sha256
from services.ingestion_service import IngestionResult, IngestionService
from services.linking_service import LinkingService
from services.categorization_service import CategorizationService
from services.category_taxonomy_service import CategoryTaxonomyService
from services.emi_service import EMIService
from services.analytics_service import AnalyticsService

__all__ = [
    "AnalyticsService",
    "CategorizationService",
    "CategoryTaxonomyService",
    "EMIService",
    "IngestionResult",
    "IngestionService",
    "LinkingService",
    "deterministic_txn_id",
    "file_sha256",
]
