"""User-editable 3-level category taxonomy.

Layout
------
The taxonomy is stored in :class:`db.models.CategoryDefinition` as a
self-referencing 3-level tree. This service hides that detail behind
three operations the UI needs:

  * ``tree()``    — load the whole taxonomy as nested dicts.
  * ``create()``  — add a new category at any level, with parent
                    validation + case-insensitive dedup.
  * ``archive()`` — soft-delete (hide from dropdowns) without touching
                    transactions that still reference the name.
  * ``rename()``  — rename in place AND cascade the rename to every
                    matching transaction string.

Why duplicate the strings on Transaction (not FK)?
    See the doc-string of CategoryDefinition. Short version: keeps
    history stable and queries cheap.
"""

from __future__ import annotations

from typing import Dict, List, Optional

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from db.models import (
    CATEGORY_KIND_EXPENSE, CATEGORY_KIND_INCOME,
    CategoryDefinition, Transaction,
)


# Public type alias for clarity in route handlers.
TaxonomyTree = Dict[str, List[dict]]   # {kind: [{name, id, children: [...]}, ...]}


class CategoryTaxonomyService:
    """CRUD + read-side traversal for the category taxonomy."""

    VALID_KINDS = {CATEGORY_KIND_EXPENSE, CATEGORY_KIND_INCOME}

    def __init__(self, session: Session) -> None:
        self.s = session

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def tree(self, include_archived: bool = False) -> TaxonomyTree:
        """Whole taxonomy as ``{expense: [...], income: [...]}``.

        Single query, then a Python-side bucket sort keyed by parent
        — cheap and correct regardless of insertion order.
        """
        q = select(CategoryDefinition).order_by(
            CategoryDefinition.level,
            CategoryDefinition.sort_order,
            CategoryDefinition.name,
        )
        if not include_archived:
            q = q.where(CategoryDefinition.archived.is_(False))
        rows = list(self.s.scalars(q))

        # Group by parent_id so we can hydrate children in O(N).
        by_parent: Dict[Optional[int], List[CategoryDefinition]] = {}
        for r in rows:
            by_parent.setdefault(r.parent_id, []).append(r)

        def serialise(node: CategoryDefinition) -> dict:
            return {
                "id":         node.id,
                "name":       node.name,
                "level":      node.level,
                "kind":       node.kind,
                "archived":   node.archived,
                "sort_order": node.sort_order,
                "children":   [serialise(c) for c in by_parent.get(node.id, [])],
            }

        out: TaxonomyTree = {CATEGORY_KIND_EXPENSE: [], CATEGORY_KIND_INCOME: []}
        for root in by_parent.get(None, []):
            out.setdefault(root.kind, []).append(serialise(root))
        return out

    def flat_paths(self) -> List[dict]:
        """All leaf+intermediate paths, useful for cross-validation.

        Each item: ``{category, subcategory, sub_subcategory, kind}``.
        """
        nodes = list(self.s.scalars(
            select(CategoryDefinition).where(CategoryDefinition.archived.is_(False))
        ))
        by_id = {n.id: n for n in nodes}
        out: List[dict] = []
        for n in nodes:
            cat = sub = subsub = None
            if n.level == 1:
                cat = n.name
            elif n.level == 2 and n.parent_id and n.parent_id in by_id:
                cat = by_id[n.parent_id].name
                sub = n.name
            elif n.level == 3 and n.parent_id and n.parent_id in by_id:
                mid = by_id[n.parent_id]
                sub = mid.name
                if mid.parent_id and mid.parent_id in by_id:
                    cat = by_id[mid.parent_id].name
                subsub = n.name
            out.append({
                "category": cat, "subcategory": sub,
                "sub_subcategory": subsub, "kind": n.kind,
            })
        return out

    def validate_path(
        self,
        category: Optional[str],
        subcategory: Optional[str],
        sub_subcategory: Optional[str],
        strict: bool = False,
    ) -> Optional[str]:
        """Returns an error string if the (cat, sub, sub-sub) triple is
        inconsistent with the taxonomy. ``None`` means valid.

        Empty / NULL category is always OK (the user is "un-categorising"
        the row). Otherwise:

        * subcategory: must be a child of category
        * sub_subcategory: must be a child of subcategory under category

        ``strict=True`` rejects unknown roots / paths entirely. The
        Excel-import flow uses strict mode so that mistyped category
        names (``Food and Dining`` vs ``Food``) are caught at upload
        time instead of silently creating drift.
        """
        if not category:
            if subcategory or sub_subcategory:
                return "subcategory / sub_subcategory require a category"
            return None

        # Allow unknown category names (the system permits free-form
        # tagging from inline editors). We only validate when the path
        # actually exists in the taxonomy — that way users aren't blocked
        # while in the middle of building their taxonomy.
        cat_row = self._find_node(category, parent_id=None)
        if cat_row is None:
            if strict:
                return f"unknown category {category!r}"
            return None   # unknown root → permissive

        if not subcategory:
            if sub_subcategory:
                return "sub_subcategory requires a subcategory"
            return None
        sub_row = self._find_node(subcategory, parent_id=cat_row.id)
        if sub_row is None:
            return f"subcategory {subcategory!r} is not a child of {category!r}"

        if sub_subcategory:
            leaf = self._find_node(sub_subcategory, parent_id=sub_row.id)
            if leaf is None:
                return (
                    f"sub_subcategory {sub_subcategory!r} is not a child of "
                    f"{category!r} → {subcategory!r}"
                )
        return None

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    def create(
        self,
        name: str,
        parent_id: Optional[int] = None,
        kind: Optional[str] = None,
    ) -> CategoryDefinition:
        """Insert a new node. Validates kind + parent + case-fold dedup."""
        name = (name or "").strip()
        if not name:
            raise ValueError("Category name cannot be empty.")

        if parent_id is None:
            level = 1
            if not kind or kind not in self.VALID_KINDS:
                raise ValueError(f"Root category requires kind in {self.VALID_KINDS!r}.")
        else:
            parent = self.s.get(CategoryDefinition, parent_id)
            if parent is None:
                raise ValueError(f"Parent {parent_id} not found.")
            if parent.level >= 3:
                raise ValueError("Cannot create a 4th-level category.")
            level = parent.level + 1
            kind = parent.kind   # inherit

        if self._find_node(name, parent_id=parent_id) is not None:
            raise ValueError(
                f"Category {name!r} already exists at this level."
            )

        # Default sort_order = (max+1) within siblings, so new entries land
        # at the bottom of dropdowns until the user reorders.
        max_so = self.s.scalar(
            select(func.coalesce(func.max(CategoryDefinition.sort_order), 0))
            .where(CategoryDefinition.parent_id == parent_id)
        ) or 0

        row = CategoryDefinition(
            name=name, level=level, parent_id=parent_id,
            kind=kind, sort_order=int(max_so) + 1,
        )
        self.s.add(row)
        self.s.commit()
        return row

    def archive(self, category_id: int) -> bool:
        """Soft-delete a node (and all its descendants) by flipping the
        ``archived`` flag. Transactions referencing the name are
        untouched — they just stop showing the option in dropdowns.
        """
        root = self.s.get(CategoryDefinition, category_id)
        if root is None:
            return False
        for n in self._descendants(root):
            n.archived = True
        root.archived = True
        self.s.commit()
        return True

    def restore(self, category_id: int) -> bool:
        """Reverse of :meth:`archive`."""
        root = self.s.get(CategoryDefinition, category_id)
        if root is None:
            return False
        for n in self._descendants(root):
            n.archived = False
        root.archived = False
        self.s.commit()
        return True

    def rename(self, category_id: int, new_name: str) -> int:
        """Rename a node + cascade the name change to every Transaction
        that references it (matches ``category`` / ``subcategory`` /
        ``sub_subcategory`` at the same level).

        Returns the number of transaction rows updated.
        """
        node = self.s.get(CategoryDefinition, category_id)
        if node is None:
            raise ValueError("Category not found.")
        new_name = (new_name or "").strip()
        if not new_name:
            raise ValueError("New name cannot be empty.")
        if self._find_node(new_name, parent_id=node.parent_id, exclude_id=node.id):
            raise ValueError(f"Sibling already named {new_name!r}.")

        old_name = node.name
        node.name = new_name

        col = {
            1: Transaction.category,
            2: Transaction.subcategory,
            3: Transaction.sub_subcategory,
        }[node.level]
        updated = self.s.execute(
            update(Transaction).where(col == old_name).values({col: new_name})
        ).rowcount or 0

        # Refunds also reference category by name.
        if node.level == 1:
            updated += self.s.execute(
                update(Transaction)
                .where(Transaction.refund_category == old_name)
                .values(refund_category=new_name)
            ).rowcount or 0

        self.s.commit()
        return int(updated)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _find_node(
        self,
        name: str,
        parent_id: Optional[int],
        exclude_id: Optional[int] = None,
    ) -> Optional[CategoryDefinition]:
        q = select(CategoryDefinition).where(
            func.lower(CategoryDefinition.name) == name.lower(),
        )
        if parent_id is None:
            q = q.where(CategoryDefinition.parent_id.is_(None))
        else:
            q = q.where(CategoryDefinition.parent_id == parent_id)
        if exclude_id is not None:
            q = q.where(CategoryDefinition.id != exclude_id)
        return self.s.scalar(q)

    def _descendants(self, node: CategoryDefinition) -> List[CategoryDefinition]:
        """All transitive children of a node (excluding the node itself)."""
        out: List[CategoryDefinition] = []
        stack = list(self.s.scalars(
            select(CategoryDefinition).where(CategoryDefinition.parent_id == node.id)
        ))
        while stack:
            cur = stack.pop()
            out.append(cur)
            stack.extend(self.s.scalars(
                select(CategoryDefinition).where(CategoryDefinition.parent_id == cur.id)
            ))
        return out
