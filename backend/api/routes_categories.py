"""Category taxonomy CRUD endpoints.

The taxonomy is a 3-level tree of user-editable nodes — see
:class:`db.models.CategoryDefinition`. These endpoints power the
category dropdowns in the UI and let the user grow / prune the tree.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.schemas import CategoryNode, TaxonomyOut
from db.database import fastapi_session
from db.models import CATEGORY_KIND_EXPENSE, CATEGORY_KIND_INCOME
from services import CategoryTaxonomyService


router = APIRouter(prefix="/api/categories", tags=["categories"])


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


@router.get("", response_model=TaxonomyOut)
def get_tree(
    include_archived: bool = False,
    db: Session = Depends(fastapi_session),
) -> TaxonomyOut:
    tree = CategoryTaxonomyService(db).tree(include_archived=include_archived)
    return TaxonomyOut(
        expense=[CategoryNode(**n) for n in tree.get(CATEGORY_KIND_EXPENSE, [])],
        income=[CategoryNode(**n) for n in tree.get(CATEGORY_KIND_INCOME, [])],
    )


# ---------------------------------------------------------------------------
# Create (any level — root requires kind, sub levels inherit from parent)
# ---------------------------------------------------------------------------


class CategoryCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    parent_id: Optional[int] = None
    # Required only when ``parent_id`` is None (i.e. creating a root).
    kind: Optional[str] = None


@router.post("", response_model=CategoryNode)
def create_node(
    body: CategoryCreateIn,
    db: Session = Depends(fastapi_session),
) -> CategoryNode:
    try:
        node = CategoryTaxonomyService(db).create(
            name=body.name, parent_id=body.parent_id, kind=body.kind,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return CategoryNode(
        id=node.id, name=node.name, level=node.level, kind=node.kind,
        archived=node.archived, sort_order=node.sort_order, children=[],
    )


# ---------------------------------------------------------------------------
# Rename / archive / restore
# ---------------------------------------------------------------------------


class CategoryRenameIn(BaseModel):
    new_name: str = Field(min_length=1, max_length=120)


@router.patch("/{category_id}/rename")
def rename_node(
    category_id: int,
    body: CategoryRenameIn,
    db: Session = Depends(fastapi_session),
):
    try:
        updated = CategoryTaxonomyService(db).rename(category_id, body.new_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"status": "ok", "transactions_updated": updated}


@router.post("/{category_id}/archive")
def archive_node(
    category_id: int,
    db: Session = Depends(fastapi_session),
):
    if not CategoryTaxonomyService(db).archive(category_id):
        raise HTTPException(status_code=404, detail="Category not found.")
    return {"status": "ok"}


@router.post("/{category_id}/restore")
def restore_node(
    category_id: int,
    db: Session = Depends(fastapi_session),
):
    if not CategoryTaxonomyService(db).restore(category_id):
        raise HTTPException(status_code=404, detail="Category not found.")
    return {"status": "ok"}
