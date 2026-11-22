"""Tagged vs untagged semantics — single source of truth.

Why this module exists
----------------------
The UI and API both need a consistent definition of "tagged". Previously
``category IS NOT NULL`` was used in SQL while the UI used Python truthiness
(``bool(category)``). Rows with ``category=''`` (empty string) appeared in
the *tagged* API filter but showed an *untagged* chip — the reported bug.

Definition (documented decision)
--------------------------------
**Tagged** — ``category`` is non-null AND non-empty after strip.
**Untagged** — ``category`` is null OR empty/whitespace-only.

Subcategory alone does **not** count as tagged. Category is the gate;
subcategory is optional refinement once a category is set.

Counterparty groups (Categorize tab)
------------------------------------
* **Tagged group** — every transaction in the group is tagged
  (``uncategorized_count == 0``).
* **Untagged group** — at least one transaction lacks a category
  (``uncategorized_count > 0``).

Used by
-------
* ``api/routes_transactions.py`` — list filter, counterparty aggregates
* ``services/analytics_service.py`` — categorization progress
* Frontend: ``lib/tagging.ts`` mirrors this logic for display chips
"""

from __future__ import annotations

from typing import Optional

from sqlalchemy import ColumnElement, or_
from sqlalchemy.orm import InstrumentedAttribute

from db.models import Transaction


def is_category_tagged(category: Optional[str]) -> bool:
    """Return True when ``category`` represents an assigned top-level tag."""
    return bool((category or "").strip())


def category_untagged_predicate(
    col: InstrumentedAttribute = Transaction.category,
) -> ColumnElement[bool]:
    """SQL: row is untagged (NULL or empty string)."""
    return or_(col.is_(None), col == "")


def category_tagged_predicate(
    col: InstrumentedAttribute = Transaction.category,
) -> ColumnElement[bool]:
    """SQL: row is tagged (non-null, non-empty category)."""
    return ~category_untagged_predicate(col)


def normalize_category_value(category: Optional[str]) -> Optional[str]:
    """Coerce blank strings to NULL for DB storage."""
    if category is None:
        return None
    s = category.strip()
    return s or None
