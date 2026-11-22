"""UI-first rule condition tree evaluator.

Condition tree format (``version: 2``) stored in ``CategorizationRule.conditions_json``::

    {
      "version": 2,
      "logic": "and",          # "and" | "or" — how items combine
      "items": [
        {"type": "condition", "field": "description", "op": "contains", "value": "AMAZON"},
        {"type": "condition", "field": "amount", "op": "between", "value": 500, "value2": 2000},
        {"type": "group", "logic": "or", "items": [ ... nested ... ]}
      ]
    }

Fields (map to Transaction columns)
------------------------------------
  description, raw_description, counterparty (merchant_name), vpa, amount,
  type (debit/credit), date, category, subcategory, account_type, txn_mode

Operators
---------
  Text: contains, not_contains, equals, not_equals, starts_with, ends_with,
        regex, is_empty, is_not_empty
  Numeric: eq, neq, gt, gte, lt, lte, between
  Date: before, after, between, month_is, day_of_month, year_is
  Category: equals, not_equals, is_empty, is_not_empty

Legacy flat conditions (no version key) still evaluated by
``rule_engine.evaluate_conditions`` for backward compatibility.

Used by
-------
  ``services/rule_engine.py`` — heuristic rule matching
  ``api/routes_rules.py`` — POST /rules/preview
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Union

from services.rule_engine import EvalContext, _txn_field

Tree = Dict[str, Any]
Txn = Any

# UI field name → transaction attribute
FIELD_MAP = {
    "description": "description",
    "raw_description": "raw_text",
    "counterparty": "merchant_name",
    "merchant_name": "merchant_name",
    "vpa": "vpa",
    "amount": "amount",
    "type": "type",
    "date": "date",
    "category": "category",
    "subcategory": "subcategory",
    "account_type": "account_type",
    "txn_mode": "txn_mode",
}

TEXT_OPS = {
    "contains", "not_contains", "equals", "not_equals",
    "starts_with", "ends_with", "regex", "is_empty", "is_not_empty",
}
NUM_OPS = {"eq", "neq", "gt", "gte", "lt", "lte", "between", "equals", "not_equals",
           "greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal"}
DATE_OPS = {"before", "after", "between", "month_is", "day_of_month", "year_is"}
CAT_OPS = {"equals", "not_equals", "is_empty", "is_not_empty"}


def is_tree_format(conditions: Optional[Dict[str, Any]]) -> bool:
    if not conditions:
        return False
    if conditions.get("version") == 2:
        return True
    return "items" in conditions and "logic" in conditions


def _field_value(txn: Txn, field: str) -> Any:
    attr = FIELD_MAP.get(field, field)
    val = _txn_field(txn, attr)
    # raw_text is often identical to description, but some rows only populate
    # description — fall back so "Raw Description" rules still match.
    if field == "raw_description" and not _str_val(val):
        val = _txn_field(txn, "description")
    return val


def _str_val(v: Any) -> str:
    return str(v or "").strip()


def _normalize_text(s: str) -> str:
    """Lowercase + collapse whitespace for forgiving contains/equals."""
    return " ".join(s.split()).lower()


def _parse_date(v: Any) -> Optional[date]:
    if v is None:
        return None
    if isinstance(v, date) and not isinstance(v, datetime):
        return v
    if isinstance(v, datetime):
        return v.date()
    s = str(v).strip()[:10]
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        return None


def _eval_text(field_val: str, op: str, value: Any, value2: Any = None) -> bool:
    hay = _normalize_text(field_val)
    needle = _normalize_text(_str_val(value))
    if op == "contains":
        return needle in hay
    if op == "not_contains":
        return needle not in hay
    if op in ("equals", "eq"):
        return hay == needle
    if op in ("not_equals", "neq"):
        return hay != needle
    if op == "starts_with":
        return hay.startswith(needle)
    if op == "ends_with":
        return hay.endswith(needle)
    if op == "regex":
        try:
            return bool(re.search(str(value), field_val, re.IGNORECASE))
        except re.error:
            return False
    if op == "is_empty":
        return not hay
    if op == "is_not_empty":
        return bool(hay)
    return False


def _eval_numeric(amt: float, op: str, value: Any, value2: Any = None) -> bool:
    op = op.replace("greater_than_or_equal", "gte").replace("greater_than", "gt")
    op = op.replace("less_than_or_equal", "lte").replace("less_than", "lt")
    if op in ("equals", "eq"):
        return amt == float(value)
    if op in ("not_equals", "neq"):
        return amt != float(value)
    if op == "gt":
        return amt > float(value)
    if op == "gte":
        return amt >= float(value)
    if op == "lt":
        return amt < float(value)
    if op == "lte":
        return amt <= float(value)
    if op == "between":
        lo, hi = float(value), float(value2)
        return lo <= amt <= hi
    return False


def _eval_date(d: Optional[date], op: str, value: Any, value2: Any = None) -> bool:
    if d is None:
        return op == "is_empty"
    if op == "before":
        bound = _parse_date(value)
        return bound is not None and d < bound
    if op == "after":
        bound = _parse_date(value)
        return bound is not None and d > bound
    if op == "between":
        lo, hi = _parse_date(value), _parse_date(value2)
        if lo is None or hi is None:
            return False
        return lo <= d <= hi
    if op == "month_is":
        return d.month == int(value)
    if op == "day_of_month":
        return d.day == int(value)
    if op == "year_is":
        return d.year == int(value)
    return False


def _eval_condition(txn: Txn, cond: Dict[str, Any]) -> bool:
    field = cond.get("field") or ""
    op = (cond.get("op") or cond.get("operator") or "equals").lower()
    value = cond.get("value")
    value2 = cond.get("value2")

    raw = _field_value(txn, field)

    if field in ("amount",):
        try:
            amt = float(raw or 0)
        except (TypeError, ValueError):
            amt = 0.0
        return _eval_numeric(amt, op, value, value2)

    if field == "date":
        d = raw if isinstance(raw, date) else _parse_date(raw)
        return _eval_date(d, op, value, value2)

    if field == "type":
        s = _str_val(raw).lower()
        v = _str_val(value).lower()
        if v in ("expense", "debit"):
            return s == "debit"
        if v in ("income", "credit"):
            return s == "credit"
        return _eval_text(s, op, v, value2)

    s = _str_val(raw)
    if field in ("category", "subcategory"):
        if op == "is_empty":
            return not s
        if op == "is_not_empty":
            return bool(s)
        return _eval_text(s, op, value, value2)

    return _eval_text(s, op, value, value2)


def _eval_items(items: List[Any], logic: str, txn: Txn, ctx: Optional[EvalContext]) -> bool:
    if not items:
        return False
    results: List[bool] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "group" or "items" in item:
            results.append(evaluate_tree(item, txn, ctx))
        else:
            results.append(_eval_condition(txn, item))
    if logic == "or":
        return any(results)
    return all(results)


def evaluate_tree(
    tree: Optional[Union[Tree, Dict[str, Any]]],
    txn: Txn,
    ctx: Optional[EvalContext] = None,
) -> bool:
    """Evaluate a v2 condition tree against one transaction."""
    if not tree:
        return False
    logic = (tree.get("logic") or tree.get("match") or "and").lower()
    items = tree.get("items") or tree.get("conditions") or []
    return _eval_items(items, logic, txn, ctx)


def empty_tree() -> Tree:
    return {"version": 2, "logic": "and", "items": []}
