"""Persistent rule engine — the single source of truth for *automatic*
categorisation across uploads.

Why a separate engine?
----------------------
:class:`services.categorization_service.CategorizationService` already
tags rows using saved ``vpa`` / ``merchant`` / ``keyword`` rules. The
engine here generalises that idea so we can add **heuristic** rules
(time-of-day, amount band, day-of-week, txn-mode, …) without rewriting
core categorisation logic. New rule types are just new predicates plugged
in next to the existing ones.

Priority order
--------------
For any transaction the engine walks rules in this order and returns the
**first** match (lower number wins). Manual edits done by the user always
sit *above* the engine — they're written directly to the row and never
overwritten by an automatic re-run unless the caller passes
``override=True``.

  1. VPA mapping       (``rule_type='vpa'``,       priority band 100)
  2. Merchant mapping  (``rule_type='merchant'``,  priority band 200)
  3. Keyword mapping   (``rule_type='keyword'``,   priority band 250)
  4. Heuristic rules   (``rule_type='heuristic'``, priority band 300+)

System (built-in) rules and user-defined rules share the table, so a
user who clones-and-tweaks the Rapido rule simply gets a higher
``priority`` and overrides the system version.

Each match yields a :class:`RuleMatch` containing the rule id, friendly
name, taxonomy tuple, and a ``source`` label (one of the
``CATEGORIZATION_SOURCE_*`` constants) — the caller persists those onto
the transaction so the UI can render an audit chip.
"""

from __future__ import annotations

import json
import logging
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time
from typing import Any, Dict, FrozenSet, List, Optional, Set, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from db.models import (
    CATEGORIZATION_SOURCE_RULE_ENGINE, RULE_TYPE_HEURISTIC, RULE_TYPE_KEYWORD,
    RULE_TYPE_MERCHANT, RULE_TYPE_TO_SOURCE, RULE_TYPE_VPA, TXN_TYPE_DEBIT,
    CategorizationRule, Transaction,
)


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public dataclass returned by the engine
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RuleMatch:
    """Outcome of a single engine evaluation for a transaction.

    Carries everything the caller needs to (a) write the categorisation
    onto the row and (b) audit how the decision was made.
    """

    rule_id: int
    rule_name: str
    rule_type: str
    source: str             # one of CATEGORIZATION_SOURCE_*
    category: str
    subcategory: Optional[str]
    sub_subcategory: Optional[str]


# ---------------------------------------------------------------------------
# Heuristic predicate helpers
# ---------------------------------------------------------------------------
#
# Conditions are stored as a JSON object. Recognised keys (all optional):
#
#   "type":         "debit" | "credit"        — txn direction
#   "txn_mode":     "UPI" | ["UPI","IMPS"]     — case-insensitive match
#   "account_type": "savings" | "credit_card"  — Transaction.account_type
#   "amount": {"min": 0, "max": 100}           — INR bands (inclusive)
#   "day_of_week": ["mon","tue",…]             — 3-letter, lowercase
#   "time_of_day": {"start": "10:00", "end": "12:00"}
#       — applies only when transactions.txn_time is populated. By default
#         the engine treats a missing txn_time as "skip the time check"
#         (so the rule still matches on data without a time-stamp). Set
#         ``"time_of_day": {"strict": true, …}`` to require a time stamp.
#   "description_contains": "rapido"           — case-insensitive substring
#   "vpa_contains":         "rapido"           — case-insensitive substring
#   "first_debit_of_day": true                 — must be the first real-flow
#       debit on that calendar date for the same account (statement order).
#       Requires :class:`EvalContext` from :class:`RuleEngine`.
#   "amount": {"max": 100, "exclusive_max": true}  — amt < 100 when set
#
# All listed conditions must be true for the heuristic to match
# (logical AND). Empty / unrecognised keys are ignored so rules are
# forward-compatible with future predicates.

_DAY_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


@dataclass(frozen=True)
class EvalContext:
    """Extra state needed by cross-transaction heuristic predicates."""

    first_debit_of_day_ids: FrozenSet[str] = frozenset()


def _coerce_list(v: Any) -> List[str]:
    if v is None:
        return []
    if isinstance(v, (list, tuple, set)):
        return [str(x).strip().lower() for x in v if str(x).strip()]
    s = str(v).strip().lower()
    return [s] if s else []


def _parse_hhmm(s: str) -> Optional[time]:
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%H:%M", "%H:%M:%S", "%I:%M%p", "%I:%M %p"):
        try:
            return datetime.strptime(s, fmt).time()
        except ValueError:
            continue
    return None


def _txn_field(txn: Any, key: str, default: Any = None) -> Any:
    """Read ``key`` from either an ORM row or a dict, gracefully."""
    if isinstance(txn, dict):
        return txn.get(key, default)
    return getattr(txn, key, default)


def _txn_mode_matches(wanted_modes: List[str], txn: Any) -> bool:
    """Return True if any ``wanted_modes`` token matches this transaction.

    Bank PDFs are inconsistent about ``txn_mode``:

    * SBI stores ``28-06-25 | UPI`` instead of bare ``UPI``.
    * Some rows leave ``txn_mode`` NULL even when the description clearly
      contains ``UPI/DR/…``.

    We therefore check the mode column **and** the description, and treat
    a mode as matched when it appears as a whole word in either string.
    """
    actual = str(_txn_field(txn, "txn_mode") or "").lower()
    desc   = str(_txn_field(txn, "description") or "").lower()
    haystacks = [actual, desc]
    if not actual and not desc:
        return False
    for mode in wanted_modes:
        m = mode.lower().strip()
        if not m:
            continue
        for hay in haystacks:
            if not hay:
                continue
            # Exact / substring after pipe (``28-06-25 | upi``).
            if hay == m or hay.endswith(f"| {m}") or hay.endswith(f"|{m}"):
                return True
            # Word-boundary match covers ``upi/dr`` and ``… | upi/dr``.
            if re.search(rf"\b{re.escape(m)}\b", hay):
                return True
    return False


def compute_first_debit_of_day_ids(session: Session) -> FrozenSet[str]:
    """Return txn ids that are the first real-flow debit per (date, account).

    Ordering uses ``(date, account_name, id)`` so ingest / statement order is
    preserved when the bank PDF does not carry transaction times.
    """
    rows = list(session.scalars(
        select(Transaction)
        .where(Transaction.type == TXN_TYPE_DEBIT)
        .order_by(Transaction.date, Transaction.account_name, Transaction.id)
    ))
    by_key: Dict[Tuple[date, str], List[Transaction]] = defaultdict(list)
    for t in rows:
        if t.is_internal_transfer or t.is_credit_card_payment or t.is_emi:
            continue
        by_key[(t.date, t.account_name or "")].append(t)

    out: Set[str] = set()
    for (_d, _acct), txns in by_key.items():
        if not txns:
            continue
        out.add(txns[0].id)
    return frozenset(out)


def evaluate_conditions(
    conditions: Dict[str, Any],
    txn: Any,
    ctx: Optional[EvalContext] = None,
) -> bool:
    """Return True iff every recognised predicate in ``conditions`` matches.

    ``txn`` may be a SQLAlchemy :class:`Transaction` row or the dict the
    ingestion pipeline builds before insert — both are supported so the
    same engine works pre-insert (during ingest) and post-insert (during
    a "run engine over existing data" sweep).
    """
    if not conditions:
        return False

    from services.rule_condition_tree import evaluate_tree, is_tree_format
    if is_tree_format(conditions):
        return evaluate_tree(conditions, txn, ctx)

    # ---- type -------------------------------------------------------
    if "type" in conditions:
        wanted = str(conditions["type"]).strip().lower()
        if wanted and wanted != str(_txn_field(txn, "type") or "").lower():
            return False

    # ---- txn_mode ---------------------------------------------------
    modes = _coerce_list(conditions.get("txn_mode"))
    if modes:
        if not _txn_mode_matches(modes, txn):
            return False

    # ---- account_type ----------------------------------------------
    if "account_type" in conditions and conditions["account_type"]:
        wanted = str(conditions["account_type"]).strip().lower()
        if wanted != str(_txn_field(txn, "account_type") or "").lower():
            return False

    # ---- amount band ------------------------------------------------
    amt_cond = conditions.get("amount") or {}
    if isinstance(amt_cond, dict) and amt_cond:
        amt = float(_txn_field(txn, "amount") or 0.0)
        lo = amt_cond.get("min")
        hi = amt_cond.get("max")
        if lo is not None and amt < float(lo):
            return False
        if hi is not None:
            cap = float(hi)
            if amt_cond.get("exclusive_max"):
                if amt >= cap:
                    return False
            elif amt > cap:
                return False

    # ---- day_of_week -----------------------------------------------
    dow = _coerce_list(conditions.get("day_of_week"))
    if dow:
        d = _txn_field(txn, "date")
        if isinstance(d, datetime):
            d = d.date()
        if not isinstance(d, date):
            return False
        if _DAY_NAMES[d.weekday()] not in dow:
            return False

    # ---- time_of_day -----------------------------------------------
    tod = conditions.get("time_of_day") or {}
    if isinstance(tod, dict) and (tod.get("start") or tod.get("end")):
        t = _txn_field(txn, "txn_time")
        if isinstance(t, datetime):
            t = t.time()
        if t is None:
            # Strict mode requires a time stamp; default is lenient so
            # the rule still matches on bank statements that don't carry
            # transaction times (most savings PDFs).
            if tod.get("strict"):
                return False
        else:
            start = _parse_hhmm(str(tod.get("start") or "00:00"))
            end   = _parse_hhmm(str(tod.get("end") or "23:59"))
            if start and t < start:
                return False
            if end and t > end:
                return False

    # ---- description / vpa substring -------------------------------
    if conditions.get("description_contains"):
        needle = str(conditions["description_contains"]).strip().lower()
        haystack = str(_txn_field(txn, "description") or "").lower()
        if needle not in haystack:
            return False

    if conditions.get("vpa_contains"):
        needle = str(conditions["vpa_contains"]).strip().lower()
        haystack = str(_txn_field(txn, "vpa") or "").lower()
        if needle not in haystack:
            return False

    # Exact equality — used by combined VPA+merchant rules (priority 95).
    if conditions.get("vpa_equals"):
        wanted = str(conditions["vpa_equals"]).strip().lower()
        actual = str(_txn_field(txn, "vpa") or "").lower()
        if wanted != actual:
            return False

    if conditions.get("merchant_contains"):
        needle = str(conditions["merchant_contains"]).strip().lower()
        haystack = str(_txn_field(txn, "merchant_name") or "").lower()
        if needle not in haystack:
            return False

    if conditions.get("merchant_equals"):
        wanted = str(conditions["merchant_equals"]).strip().lower()
        actual = str(_txn_field(txn, "merchant_name") or "").lower()
        if wanted != actual:
            return False

    # ---- exclusion lists (any hit → reject) ------------------------
    exclude_blob = " ".join(
        str(_txn_field(txn, key) or "")
        for key in ("description", "vpa", "merchant_name", "raw_text")
    ).lower()
    for needle in conditions.get("description_excludes") or []:
        token = str(needle).strip().lower()
        if token and token in exclude_blob:
            return False

    # ---- first debit of the day (per account) -----------------------
    if conditions.get("first_debit_of_day"):
        if ctx is None:
            return False
        txn_id = str(_txn_field(txn, "id") or "")
        if txn_id not in ctx.first_debit_of_day_ids:
            return False

    return True


# ---------------------------------------------------------------------------
# RuleEngine — orchestrator
# ---------------------------------------------------------------------------


def _norm(s: Optional[str]) -> str:
    return (s or "").strip().lower()


def _rule_friendly_name(rule: CategorizationRule) -> str:
    if rule.name:
        return rule.name
    return f"{rule.rule_type.title()}: {rule.rule_value}"


class RuleEngine:
    """Walks the persistent rules table in priority order.

    The engine is **stateless across calls** — each
    :meth:`categorize` re-evaluates against the current rules. Heavy
    callers (ingestion, "run engine" endpoint) should construct one
    engine and call :meth:`prepare` once to cache the rule list.
    """

    # Default per-rule-type priorities. Used when a new rule is created
    # without an explicit priority. Lower wins.
    DEFAULT_PRIORITY = {
        RULE_TYPE_VPA:       100,
        RULE_TYPE_MERCHANT:  200,
        RULE_TYPE_KEYWORD:   250,
        RULE_TYPE_HEURISTIC: 300,
    }

    def __init__(self, session: Session) -> None:
        self.s = session
        self._vpa_idx: Dict[str, CategorizationRule] = {}
        self._merchant_idx: Dict[str, CategorizationRule] = {}
        self._keyword_rules: List[CategorizationRule] = []
        self._heuristic_rules: List[Tuple[CategorizationRule, Dict[str, Any]]] = []
        self._heuristic_by_id: Dict[int, Tuple[CategorizationRule, Dict[str, Any]]] = {}
        self._eval_ctx: Optional[EvalContext] = None
        self._loaded = False

    # ------------------------------------------------------------------
    # Cache management
    # ------------------------------------------------------------------

    def prepare(self) -> None:
        """Load all enabled rules into per-type fast-path indexes.

        Cheap (rules table is small) but worth caching across many
        transactions during a bulk run.
        """
        rules = list(self.s.scalars(
            select(CategorizationRule)
            .where(CategorizationRule.enabled.is_(True))
            .order_by(CategorizationRule.priority, CategorizationRule.id)
        ))
        self._vpa_idx.clear()
        self._merchant_idx.clear()
        self._keyword_rules.clear()
        self._heuristic_rules.clear()
        self._heuristic_by_id.clear()
        for r in rules:
            if r.rule_type == RULE_TYPE_VPA:
                self._vpa_idx.setdefault(_norm(r.rule_value), r)
            elif r.rule_type == RULE_TYPE_MERCHANT:
                self._merchant_idx.setdefault(_norm(r.rule_value), r)
            elif r.rule_type == RULE_TYPE_KEYWORD:
                self._keyword_rules.append(r)
            elif r.rule_type == RULE_TYPE_HEURISTIC:
                cond = _safe_json(r.conditions_json) or {}
                if cond:
                    self._heuristic_rules.append((r, cond))
                    self._heuristic_by_id[r.id] = (r, cond)
        needs_first = any(
            bool(c.get("first_debit_of_day"))
            for _, c in self._heuristic_rules
        )
        self._eval_ctx = EvalContext(
            first_debit_of_day_ids=(
                compute_first_debit_of_day_ids(self.s) if needs_first else frozenset()
            ),
        )
        self._loaded = True

    # ------------------------------------------------------------------
    # Single-transaction evaluation
    # ------------------------------------------------------------------

    def categorize(self, txn: Any) -> Optional[RuleMatch]:
        """Return the first matching rule for ``txn`` or ``None``.

        ``txn`` may be a :class:`Transaction` ORM row OR the dict the
        ingestion pipeline builds before insert.
        """
        if not self._loaded:
            self.prepare()

        # 0. High-priority heuristics (e.g. combined VPA+merchant at 95)
        for r, cond in self._heuristic_rules:
            if int(r.priority or 300) >= self.DEFAULT_PRIORITY[RULE_TYPE_VPA]:
                break
            if evaluate_conditions(cond, txn, self._eval_ctx):
                return _to_match(r)

        # 1. VPA
        vpa = _norm(_txn_field(txn, "vpa"))
        if vpa and vpa in self._vpa_idx:
            return _to_match(self._vpa_idx[vpa])

        # 2. Merchant
        mch = _norm(_txn_field(txn, "merchant_name"))
        if mch and mch in self._merchant_idx:
            return _to_match(self._merchant_idx[mch])

        # 3. Keyword
        desc = str(_txn_field(txn, "description") or "").lower()
        for r in self._keyword_rules:
            if _norm(r.rule_value) in desc:
                return _to_match(r)

        # 4. Heuristic — already sorted by priority during ``prepare``
        for r, cond in self._heuristic_rules:
            if evaluate_conditions(cond, txn, self._eval_ctx):
                return _to_match(r)

        return None

    # ------------------------------------------------------------------
    # Bulk: in-memory tagging of dicts (ingest path)
    # ------------------------------------------------------------------

    def apply_to_dicts(self, rows: List[dict]) -> int:
        """Pre-insert tagging.

        Walks each row, runs the engine, and writes the resulting
        category / source / rule id back onto the dict. Skips rows that
        already carry a category (e.g. tagged by income auto-detect).
        Returns the number of rows the engine touched.
        """
        if not rows:
            return 0
        if not self._loaded:
            self.prepare()
        n = 0
        for row in rows:
            if row.get("category"):
                continue
            match = self.categorize(row)
            if not match:
                continue
            row["category"]               = match.category
            row["subcategory"]            = match.subcategory
            row["sub_subcategory"]        = match.sub_subcategory
            row["categorization_source"]  = match.source
            row["categorized_by_rule_id"] = match.rule_id
            n += 1
        return n

    # ------------------------------------------------------------------
    # Bulk: post-insert sweep (e.g. "Run engine over uncategorised")
    # ------------------------------------------------------------------

    def _reconcile_heuristic_tags(self) -> int:
        """Drop heuristic tags that no longer satisfy their rule conditions."""
        if not self._heuristic_by_id:
            return 0
        cleared = 0
        rows = self.s.scalars(
            select(Transaction).where(
                Transaction.categorized_by_rule_id.in_(self._heuristic_by_id.keys())
            )
        )
        for t in rows:
            entry = self._heuristic_by_id.get(t.categorized_by_rule_id or 0)
            if not entry:
                continue
            _rule, cond = entry
            if evaluate_conditions(cond, t, self._eval_ctx):
                continue
            t.category               = None
            t.subcategory            = None
            t.sub_subcategory        = None
            t.categorization_source  = None
            t.categorized_by_rule_id = None
            cleared += 1
        return cleared

    def run_over_uncategorized(self) -> dict:
        """Apply the engine to every uncategorised transaction in the DB.

        Heuristic tags from a previous (looser) rule version are cleared
        first when they no longer match — e.g. after tightening the
        daily-commute rule to *first debit of the day* only.

        Returns a small report:
          ``{"scanned": N, "matched": M, "cleared": C, "by_source": {...}}``
        """
        if not self._loaded:
            self.prepare()
        cleared = self._reconcile_heuristic_tags()
        scanned = 0
        matched = 0
        by_source: Dict[str, int] = {}
        rows = self.s.scalars(
            select(Transaction).where(Transaction.category.is_(None))
        )
        for t in rows:
            scanned += 1
            match = self.categorize(t)
            if not match:
                continue
            t.category               = match.category
            t.subcategory            = match.subcategory
            t.sub_subcategory        = match.sub_subcategory
            t.categorization_source  = match.source
            t.categorized_by_rule_id = match.rule_id
            matched += 1
            by_source[match.source] = by_source.get(match.source, 0) + 1
        self.s.commit()
        return {
            "scanned": scanned,
            "matched": matched,
            "cleared": cleared,
            "by_source": by_source,
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _safe_json(blob: Optional[str]) -> Optional[dict]:
    if not blob:
        return None
    try:
        out = json.loads(blob)
        return out if isinstance(out, dict) else None
    except (TypeError, ValueError):
        logger.warning("Bad rule conditions_json: %r", blob[:120])
        return None


def _to_match(rule: CategorizationRule) -> RuleMatch:
    return RuleMatch(
        rule_id=rule.id,
        rule_name=_rule_friendly_name(rule),
        rule_type=rule.rule_type,
        source=RULE_TYPE_TO_SOURCE.get(rule.rule_type, CATEGORIZATION_SOURCE_RULE_ENGINE),
        category=rule.category,
        subcategory=rule.subcategory,
        sub_subcategory=rule.sub_subcategory,
    )
