"""Rule engine + VPA/merchant extraction + propagation.

Three rule types
----------------
* ``vpa``      – exact match (case-folded) against ``transactions.vpa``.
* ``keyword``  – case-insensitive substring of the description.
* ``merchant`` – exact match against ``transactions.merchant_name``.

VPA rules win against merchant rules win against keyword rules
(see :data:`_RULE_PRIORITY`) so the most-specific signal beats the
weakest.

Extraction & canonicalisation
-----------------------------
The parsers already populate ``txn_vpa`` and ``txn_counterparty``
for UPI rows. For non-UPI rows (CC merchants, NEFT etc.) we run
:func:`extract_merchant_name` over the description as a fallback.

Two layers of normalisation collapse cosmetic variations into a single
canonical merchant_name so "Apply to all similar transactions" works:

  1. :data:`_CANONICAL_PATTERNS` — high-precision regexes that fold
     bank-side flows ("INTEREST CREDIT", "SAV INT", "SB INTEREST PAID")
     into a single canonical merchant ("Bank Interest"). These run
     **before** alias / token extraction, so they win.
  2. :data:`_MERCHANT_ALIASES` — known consumer merchants ("zomato
     ltd", "Zomato India", "ZOMATO" → ``"Zomato"``).

After ingest you can also call :meth:`CategorizationService.recanonicalize_all`
to retro-apply the rules to existing rows (useful after expanding the
patterns).
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from db.models import (
    CATEGORIZATION_SOURCE_AUTO_INCOME, CATEGORIZATION_SOURCE_MANUAL,
    RULE_TYPE_HEURISTIC, RULE_TYPE_KEYWORD, RULE_TYPE_MERCHANT,
    RULE_TYPE_TO_SOURCE, RULE_TYPE_VPA, CategorizationRule, Transaction,
)


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Counterparty / merchant extraction
# ---------------------------------------------------------------------------

# Canonical-merchant patterns. These fold bank-side / generic flows that
# show up under many slightly-different descriptions into a single
# canonical merchant_name string, so "Apply to all similar transactions"
# in the UI groups them together. ORDER MATTERS — first match wins.
#
# Regexes are intentionally generous: "INTEREST CREDIT", "INT.PD",
# "SAV INT", "SB INTEREST" and "SAVINGS INTEREST PAID" all canonicalise
# to ``"Bank Interest"`` so a single rule covers the lot.
#
# When you add a new pattern here, run ``POST /api/rules/recanonicalize``
# to retro-apply it to existing transactions.
_CANONICAL_PATTERNS: List[Tuple[re.Pattern, str]] = [
    # ---- bank-side credits ------------------------------------------
    (re.compile(
        r"(?:"
        # quarterly / monthly interest credit (free-standing)
        r"\b(?:qtr?ly|qtly|quarterly|monthly|annual)\s*interest\b|"
        # interest{credit/paid/pd} — separators may be whitespace, '.', ':'
        r"\binterest[\s.:_-]*(?:cr|credit|paid|pd)\b|"
        # int{credit/paid/pd} — same separators (catches 'INT.PD', 'INT_CR')
        r"\bint[\s.:_-]*(?:cr|credit|paid|pd)\b|"
        # savings interest in many wordings
        r"\bsav(?:ings?)?\s*int(?:erest)?\b|"
        r"\bsb\s*int(?:erest)?\b|"
        r"\bfd\s*int(?:erest)?\b|"
        r"\btdr?\s*int(?:erest)?\b"
        r")",
        re.IGNORECASE,
    ), "Bank Interest"),
    (re.compile(
        r"\b(?:salary|sal\s*cr(?:edit)?|payroll|monthly\s*salary)\b",
        re.IGNORECASE,
    ), "Salary Credit"),
    (re.compile(r"\b(?:dividend|div\s*pay)\b", re.IGNORECASE), "Dividend"),

    # ---- bank-side debits / charges ---------------------------------
    (re.compile(
        r"\b(?:atm\s*wd?l?|atm\s*cash|atm\s*withdrawal|cash\s*wd?l?)\b",
        re.IGNORECASE,
    ), "ATM Withdrawal"),
    (re.compile(
        r"\b(?:service\s*charge|sms\s*chg|sms\s*charge|annual\s*fee|amc\s*fee|"
        r"maintenance\s*fee|cheque\s*book\s*fee|chq\s*book\s*chg)\b",
        re.IGNORECASE,
    ), "Bank Charges"),
    (re.compile(
        r"\b(?:gst|igst|sgst|cgst|tax\s*on\s*int|tds)\b",
        re.IGNORECASE,
    ), "Bank Tax / GST"),
    (re.compile(
        r"\b(?:emi|equated\s*monthly\s*instalment|loan\s*emi)\b",
        re.IGNORECASE,
    ), "EMI Payment"),

    # ---- transfers (these will likely also be flagged is_internal_transfer
    #      but we still give them a stable group label for UX). ------
    (re.compile(r"\b(?:imps|neft|rtgs)\b.*\b(?:transfer|trf)\b", re.IGNORECASE), "Bank Transfer"),
]

# UPI handle, e.g. "ramesh@okaxis"
_VPA_RE = re.compile(r"\b([A-Za-z0-9._-]+@[A-Za-z]{3,})\b")

# Tail of a UPI / IMPS / NEFT reference, e.g. "UPI/DR/123/ZOMATO"
_UPI_TAIL_RE = re.compile(
    r"\b(?:UPI|IMPS|NEFT|RTGS)\b[^\s]*?/([A-Za-z][A-Za-z0-9 &._-]{2,})$",
    re.IGNORECASE,
)

# Generic alphabetic merchant token (fallback).
_MERCHANT_TOKEN_RE = re.compile(r"\b([A-Za-z][A-Za-z &.'\-]{2,30})\b")

# Banking jargon that we never want to surface as a "merchant".
_NOISE_TOKENS = {
    "upi", "imps", "neft", "rtgs", "txn", "trf", "ref", "rrn", "dr", "cr",
    "debit", "credit", "transfer", "payment", "pay", "from", "to", "the",
    "for", "via", "vpa", "id", "no", "by", "of", "in", "and", "or",
    "purchase", "transaction", "cashback", "interest", "balance",
    "period", "spend", "refund", "fee", "charge", "tax",
}

# Known merchant aliases — collapse common variants to a single token so
# analytics groups them together. (Keys are lower-cased.) Extend as we
# learn more from real data.
_MERCHANT_ALIASES: Dict[str, str] = {
    # food / quick commerce
    "swiggy":     "Swiggy",
    "zomato":     "Zomato",
    "blinkit":    "Blinkit",
    "zepto":      "Zepto",
    "instamart":  "Instamart",
    # transport
    "uber":       "Uber",
    "ola":        "Ola",
    "rapido":     "Rapido",
    # shopping
    "amazon":     "Amazon",
    "flipkart":   "Flipkart",
    "myntra":     "Myntra",
    "ajio":       "Ajio",
    "meesho":     "Meesho",
    # entertainment
    "netflix":    "Netflix",
    "spotify":    "Spotify",
    "youtube":    "YouTube",
    # bills
    "airtel":     "Airtel",
    "jio":        "Jio",
    "vodafone":   "Vodafone",
    # finance
    "sbi":        "SBI",
    "slice":      "Slice",
    "canara":     "Canara",
}


def extract_vpa(description: str) -> Optional[str]:
    """Best-effort VPA extraction from a description."""
    if not description:
        return None
    m = _VPA_RE.search(description)
    return m.group(1).lower() if m else None


def canonicalize_from_description(description: str) -> Optional[str]:
    """High-precision canonicalisation for bank-side flows.

    Returns the canonical merchant name if a :data:`_CANONICAL_PATTERNS`
    regex matches, otherwise None. Used as the *first* extraction step so
    "INTEREST CREDIT" and "SAV INT PAID" both collapse to ``"Bank Interest"``.
    """
    if not description:
        return None
    for pat, canonical in _CANONICAL_PATTERNS:
        if pat.search(description):
            return canonical
    return None


def extract_merchant_name(description: str) -> Optional[str]:
    """Best-effort merchant name.

    Order:

    1. Canonical patterns (interest, salary, ATM, bank charges, …) so
       bank-side flows always group together regardless of wording.
    2. Known consumer-merchant aliases (Zomato, Swiggy, Amazon, …).
    3. UPI tail (``UPI/DR/123/ZOMATO`` → ``"Zomato"``).
    4. Longest non-noise alphabetic token in the description.
    """
    if not description:
        return None

    canonical = canonicalize_from_description(description)
    if canonical:
        return canonical

    desc_lc = description.lower()
    for needle, canonical in _MERCHANT_ALIASES.items():
        if needle in desc_lc:
            return canonical

    m = _UPI_TAIL_RE.search(description)
    if m:
        return m.group(1).strip().title()

    best = ""
    for m in _MERCHANT_TOKEN_RE.finditer(description):
        tok = m.group(1).strip()
        if tok.lower() in _NOISE_TOKENS or len(tok) < 3:
            continue
        if len(tok) > len(best):
            best = tok
    return best.title() if best else None


# ---------------------------------------------------------------------------
# Income auto-detection (runs on every ingested credit row)
# ---------------------------------------------------------------------------
#
# We tag obvious income flavours at ingest time so the user doesn't have
# to manually categorise every salary or interest credit. These tags are
# only applied when the row has no category yet AND the row is a credit
# AND it's not flagged as an internal transfer.
#
# This is intentionally conservative: we'd rather under-tag and let the
# user correct via the Categorize page than over-tag and corrupt their
# income view.

# Income patterns — these are GENUINE income credits.
# Tuple: (regex, category, subcategory)
_INCOME_RULES: List[Tuple[re.Pattern, str, str]] = [
    # Salary — common Indian-payroll wordings.
    (re.compile(r"\bsalary\b",                 re.IGNORECASE), "Income", "Salary"),
    (re.compile(r"\bsal\s*cr\b",               re.IGNORECASE), "Income", "Salary"),
    (re.compile(r"\bneft\s*cr.*sal\b",         re.IGNORECASE), "Income", "Salary"),
    (re.compile(r"\bpayroll\b",                re.IGNORECASE), "Income", "Salary"),

    # Interest — savings / FD.
    (re.compile(r"\binterest\s*(cr|credit|paid)\b", re.IGNORECASE), "Income", "Interest Income"),
    (re.compile(r"\bint\s*pd\b",               re.IGNORECASE), "Income", "Interest Income"),
    (re.compile(r"\bsav\s*int\b",              re.IGNORECASE), "Income", "Interest Income"),

    # Dividend
    (re.compile(r"\bdividend\b",               re.IGNORECASE), "Income", "Dividends"),
    (re.compile(r"\bdiv\s*pay\b",              re.IGNORECASE), "Income", "Dividends"),

    # Scholarships / pocket money are too rare + too generic to detect
    # reliably from PDF text — leave for manual categorization.
]


# Refund patterns — these are CREDITS that should NOT be counted as
# income; they offset spend elsewhere. We flag them with is_refund=True
# but DO NOT auto-pick a refund_category because we can't infer the
# original spend bucket from the credit text alone (the user picks it
# via the UI). Spec PART 3 / PART 7.
_REFUND_PATTERNS: List[re.Pattern] = [
    re.compile(p, re.IGNORECASE) for p in [
        r"\bcashback\b",
        r"\bcash\s*back\b",
        r"\brefund\b",
        r"\brefnd\b",
        r"\breversed?\b",
    ]
]


def detect_income_category(row: dict) -> Optional[Tuple[str, str]]:
    """Return ``(category, subcategory)`` if this row looks like income."""
    if row.get("type") != "credit":
        return None
    if row.get("is_internal_transfer"):
        return None
    desc = (row.get("description") or "")
    if not desc:
        return None
    for pat, cat, sub in _INCOME_RULES:
        if pat.search(desc):
            return cat, sub
    return None


# Refund sub-types stored in ``subcategory`` on refund credits.
REFUND_SUBTYPES = (
    "Shared Expense Recovery",
    "Merchant Refund",
    "Reimbursement",
    "Other",
)

_SHARED_RECOVERY_PATTERNS = [
    re.compile(p, re.IGNORECASE) for p in [
        r"\bpay\s*back\b", r"\bpayback\b", r"\bsplit\b", r"\bshared\b",
        r"\bfriend\b", r"\bowed\b", r"\bsettle\b",
    ]
]
_REIMBURSE_PATTERNS = [
    re.compile(p, re.IGNORECASE) for p in [
        r"\breimburs", r"\bexpense\s*claim\b",
    ]
]


def detect_refund_subtype(row: dict) -> str:
    """Classify a refund credit — stored in ``subcategory``."""
    desc = (row.get("description") or "")
    if any(p.search(desc) for p in _SHARED_RECOVERY_PATTERNS):
        return "Shared Expense Recovery"
    if any(p.search(desc) for p in _REIMBURSE_PATTERNS):
        return "Reimbursement"
    if looks_like_refund(row):
        return "Merchant Refund"
    return "Other"


def looks_like_refund(row: dict) -> bool:
    """Lightweight cashback / refund detector for ingestion-time tagging.

    Only fires on credits and only matches obvious patterns — the user
    still has to confirm the *refund_category* (the bucket the credit
    offsets) via the UI.
    """
    if row.get("type") != "credit":
        return False
    if row.get("is_internal_transfer"):
        return False
    desc = (row.get("description") or "")
    return any(p.search(desc) for p in _REFUND_PATTERNS)


def apply_income_autotag(rows: List[dict]) -> int:
    """In-place autotag.

    Two passes:
      1. Mark rows that look like refunds with ``is_refund=True``. These
         intentionally do NOT get a category — the user picks the
         offset bucket on the Categorize page or detail drawer.
      2. Tag remaining un-categorised rows that match salary / interest
         / dividend patterns with the appropriate Income/* path.

    Returns the count of rows TOUCHED (refund-flagged + income-tagged).
    """
    n = 0
    for r in rows:
        # Pass 1: refunds (cashback / refund / reversed / refnd).
        if not r.get("is_refund") and looks_like_refund(r):
            r["is_refund"] = True
            r["subcategory"] = detect_refund_subtype(r)
            n += 1
            continue

        # Pass 2: income.
        if r.get("category"):
            continue
        match = detect_income_category(r)
        if match:
            r["category"], r["subcategory"] = match
            r.setdefault("categorization_source", CATEGORIZATION_SOURCE_AUTO_INCOME)
            n += 1
    return n


# ---------------------------------------------------------------------------
# Rule engine
# ---------------------------------------------------------------------------

# Rules of more specific types beat less specific ones (lower number = higher).
# Heuristic rules use their own ``priority`` column directly so the engine
# can interleave them with VPA / merchant / keyword bands as needed.
_RULE_PRIORITY = {
    RULE_TYPE_VPA:       100,
    RULE_TYPE_MERCHANT:  200,
    RULE_TYPE_KEYWORD:   250,
    RULE_TYPE_HEURISTIC: 300,
}


def _norm(s: Optional[str]) -> str:
    if not s:
        return ""
    return s.strip().lower()


class CategorizationService:
    """Stateful rules + propagation, backed by SQLite via SQLAlchemy."""

    def __init__(self, session: Session) -> None:
        self.s = session

    # ------------------------------------------------------------------
    # In-memory rule application (pre-insert, no DB write)
    # ------------------------------------------------------------------

    def apply_rules_to_dicts(self, rows: List[dict]) -> int:
        """Tag dict rows in-place via the persistent rule engine.

        Delegates to :class:`services.rule_engine.RuleEngine` so this
        path includes heuristic rules (Rapido, future Salary detection,
        …) on top of vpa / merchant / keyword mappings, and stamps a
        ``categorization_source`` + ``categorized_by_rule_id`` onto every
        tagged row for the audit chip.

        Returns the number of rows that received a category.
        """
        # Local import keeps services/categorization_service importable
        # without bringing the engine module into every consumer.
        from services.rule_engine import RuleEngine

        engine = RuleEngine(self.s)
        return engine.apply_to_dicts(rows)

    # ------------------------------------------------------------------
    # Rule CRUD + propagation against the DB
    # ------------------------------------------------------------------

    def upsert_rule(
        self,
        rule_type: str,
        rule_value: str,
        category: str,
        subcategory: Optional[str] = None,
        sub_subcategory: Optional[str] = None,
        propagate: bool = True,
        name: Optional[str] = None,
    ) -> Tuple[CategorizationRule, int]:
        """Create / update a rule and (optionally) apply to all existing rows.

        Returns ``(rule, n_transactions_updated)``.
        """
        if rule_type not in _RULE_PRIORITY:
            raise ValueError(f"Unknown rule_type: {rule_type}")
        rule_value_norm = _norm(rule_value)
        if not rule_value_norm:
            raise ValueError("rule_value cannot be empty")

        existing = self.s.scalar(
            select(CategorizationRule).where(
                CategorizationRule.rule_type == rule_type,
                func.lower(CategorizationRule.rule_value) == rule_value_norm,
            )
        )
        if existing:
            existing.category        = category
            existing.subcategory     = subcategory
            existing.sub_subcategory = sub_subcategory
            if name:
                existing.name = name
            rule = existing
        else:
            rule = CategorizationRule(
                rule_type=rule_type,
                rule_value=rule_value_norm,
                category=category,
                subcategory=subcategory,
                sub_subcategory=sub_subcategory,
                priority=_RULE_PRIORITY[rule_type],
                name=name or f"{rule_type.title()}: {rule_value_norm}",
                enabled=True,
                is_system=False,
            )
            self.s.add(rule)
        self.s.flush()

        updated = self._propagate_rule(rule) if propagate else 0
        self.s.commit()
        return rule, updated

    def delete_rule(self, rule_id: int, clear_transactions: bool = False) -> int:
        rule = self.s.get(CategorizationRule, rule_id)
        if not rule:
            return 0
        n = 0
        if clear_transactions:
            n = self._clear_transactions_for_rule(rule)
        self.s.delete(rule)
        self.s.commit()
        return n

    def list_rules(self) -> List[CategorizationRule]:
        return list(self.s.scalars(
            select(CategorizationRule)
            .order_by(CategorizationRule.priority, CategorizationRule.rule_type, CategorizationRule.rule_value)
        ))

    # ------------------------------------------------------------------
    # Per-transaction edits
    # ------------------------------------------------------------------

    def set_transaction_category(
        self,
        txn_id: str,
        category: Optional[str],
        subcategory: Optional[str] = None,
        sub_subcategory: Optional[str] = None,
        propagate_via: Optional[str] = None,  # 'vpa' | 'merchant' | None
        source: str = CATEGORIZATION_SOURCE_MANUAL,
    ) -> int:
        """Update one transaction's category. Optionally save a propagation rule.

        Always stamps :attr:`Transaction.categorization_source` so the UI
        chip reflects the latest authoritative tag. ``source`` defaults to
        ``"manual"`` (user clicked the categorise button); callers from
        the Excel-import path should pass ``"excel_import"``.
        """
        txn = self.s.get(Transaction, txn_id)
        if not txn:
            return 0
        txn.category               = category
        txn.subcategory            = subcategory
        txn.sub_subcategory        = sub_subcategory
        # Manual edits clear the rule pointer — the audit chip should
        # say "Manual", not "Rule-Based: <something>" once the user has
        # touched the row.
        txn.categorization_source  = source if category else None
        txn.categorized_by_rule_id = None

        if propagate_via and category:
            rule_value = txn.vpa if propagate_via == RULE_TYPE_VPA else txn.merchant_name
            if rule_value:
                _, _ = self.upsert_rule(
                    rule_type=propagate_via,
                    rule_value=rule_value,
                    category=category,
                    subcategory=subcategory,
                    sub_subcategory=sub_subcategory,
                    propagate=True,
                )
            else:
                self.s.commit()
        else:
            self.s.commit()
        return 1

    # ------------------------------------------------------------------
    # Bulk: apply rules to existing rows (e.g. after restoring backup)
    # ------------------------------------------------------------------

    def reapply_all_rules(self) -> int:
        """Re-run the entire rules list against every transaction."""
        rules = self._load_rules_sorted()
        if not rules:
            return 0
        n = 0
        for r in rules:
            n += self._propagate_rule(r)
        self.s.commit()
        return n

    # ------------------------------------------------------------------
    # Bulk: re-canonicalise merchant_name on existing transactions.
    # ------------------------------------------------------------------

    def recanonicalize_all(self) -> dict:
        """Walk every transaction and recompute ``merchant_name`` from its
        description using the latest :data:`_CANONICAL_PATTERNS` and
        :data:`_MERCHANT_ALIASES`.

        This is the antidote to "Apply to all similar transactions only
        updated some" — once merchant_name is consistent, a single
        merchant rule covers every variant.

        Returns ``{"transactions_scanned": N, "merchant_changed": M}``.
        """
        scanned = 0
        changed = 0
        for t in self.s.scalars(select(Transaction)):
            scanned += 1
            new_name = extract_merchant_name(t.description or "")
            if new_name and new_name != (t.merchant_name or ""):
                t.merchant_name = new_name
                changed += 1
        self.s.commit()
        return {"transactions_scanned": scanned, "merchant_changed": changed}

    # ------------------------------------------------------------------
    # Bulk: "Apply to all similar" — robust grouping that beats per-VPA-only.
    # ------------------------------------------------------------------

    def apply_category_to_group(
        self,
        *,
        kind: str,                # 'vpa' | 'merchant' | 'description' | 'combined'
        value: str,
        category: str,
        subcategory: Optional[str] = None,
        sub_subcategory: Optional[str] = None,
        save_rule: bool = True,
        source: str = CATEGORIZATION_SOURCE_MANUAL,
        vpa_value: Optional[str] = None,
        merchant_value: Optional[str] = None,
    ) -> dict:
        """Apply a category to every transaction matching a logical group.

        ``kind`` decides the matching predicate:

        * ``vpa``         — case-insensitive equality on ``Transaction.vpa``.
        * ``merchant``    — case-insensitive equality on ``Transaction.merchant_name``.
        * ``description`` — case-insensitive substring of ``Transaction.description``.
        * ``combined``    — both ``vpa_value`` AND ``merchant_value`` must match
                            exactly; persists a heuristic rule (priority 95).

        When ``save_rule`` is True a corresponding rule is upserted so
        future imports inherit the categorisation automatically.
        """
        if not category:
            raise ValueError("category is required")

        if kind == "combined":
            vpa_v = (vpa_value or "").strip()
            mch_v = (merchant_value or "").strip()
            if not vpa_v or not mch_v:
                raise ValueError("combined kind requires vpa_value and merchant_value")
            pred = and_(
                func.lower(Transaction.vpa) == vpa_v.lower(),
                func.lower(Transaction.merchant_name) == mch_v.lower(),
            )
            match_value = f"{mch_v}|{vpa_v}"
        else:
            v = value.strip()
            if not v:
                raise ValueError("value cannot be empty")
            if kind == "vpa":
                pred = func.lower(Transaction.vpa) == v.lower()
            elif kind == "merchant":
                pred = func.lower(Transaction.merchant_name) == v.lower()
            elif kind == "description":
                pred = func.lower(Transaction.description).like(f"%{v.lower()}%")
            else:
                raise ValueError(f"Unknown grouping kind: {kind}")
            match_value = v

        rows = list(self.s.scalars(select(Transaction).where(pred)))
        rule: Optional[CategorizationRule] = None
        if save_rule:
            if kind == "combined":
                conditions = {
                    "vpa_equals": vpa_v,
                    "merchant_equals": mch_v,
                }
                rule = self._upsert_heuristic_rule(
                    rule_value=match_value.lower(),
                    category=category,
                    subcategory=subcategory,
                    sub_subcategory=sub_subcategory,
                    conditions=conditions,
                    name=f"Combined: {mch_v} + {vpa_v}",
                    priority=95,
                )
            else:
                rule_type = (
                    RULE_TYPE_VPA      if kind == "vpa"
                    else RULE_TYPE_MERCHANT if kind == "merchant"
                    else RULE_TYPE_KEYWORD
                )
                rule, _ = self.upsert_rule(
                    rule_type=rule_type,
                    rule_value=match_value,
                    category=category,
                    subcategory=subcategory,
                    sub_subcategory=sub_subcategory,
                    propagate=False,
                )

        for t in rows:
            t.category               = category
            t.subcategory            = subcategory
            t.sub_subcategory        = sub_subcategory
            t.categorization_source  = source
            t.categorized_by_rule_id = rule.id if rule else None
        self.s.commit()
        return {
            "transactions_updated": len(rows),
            "rule_id":              rule.id if rule else None,
        }

    # ------------------------------------------------------------------
    # Private
    # ------------------------------------------------------------------

    def _upsert_heuristic_rule(
        self,
        *,
        rule_value: str,
        category: str,
        subcategory: Optional[str],
        sub_subcategory: Optional[str],
        conditions: Dict[str, Any],
        name: str,
        priority: int = 300,
    ) -> CategorizationRule:
        """Create or update a heuristic (JSON conditions) rule."""
        rv = _norm(rule_value)
        existing = self.s.scalar(
            select(CategorizationRule).where(
                CategorizationRule.rule_type == RULE_TYPE_HEURISTIC,
                func.lower(CategorizationRule.rule_value) == rv,
            )
        )
        cond_json = json.dumps(conditions, sort_keys=True)
        if existing:
            existing.category = category
            existing.subcategory = subcategory
            existing.sub_subcategory = sub_subcategory
            existing.conditions_json = cond_json
            existing.name = name
            existing.priority = priority
            rule = existing
        else:
            rule = CategorizationRule(
                rule_type=RULE_TYPE_HEURISTIC,
                rule_value=rv,
                category=category,
                subcategory=subcategory,
                sub_subcategory=sub_subcategory,
                conditions_json=cond_json,
                priority=priority,
                name=name,
                enabled=True,
                is_system=False,
            )
            self.s.add(rule)
        self.s.flush()
        return rule

    def _load_rules_sorted(self) -> List[CategorizationRule]:
        return list(self.s.scalars(
            select(CategorizationRule).order_by(CategorizationRule.priority)
        ))

    def _propagate_rule(self, rule: CategorizationRule) -> int:
        """Apply one rule to every matching transaction. Returns row count.

        Stamps the :attr:`Transaction.categorization_source` and
        :attr:`Transaction.categorized_by_rule_id` so a "Rule-Based" chip
        appears in the UI without the caller having to remember.
        """
        from services.rule_engine import evaluate_conditions, _safe_json

        source = RULE_TYPE_TO_SOURCE.get(rule.rule_type)
        count = 0

        if rule.rule_type == RULE_TYPE_HEURISTIC:
            cond = _safe_json(rule.conditions_json) or {}
            if not cond:
                return 0
            for t in self.s.scalars(select(Transaction)):
                if evaluate_conditions(cond, t):
                    t.category = rule.category
                    t.subcategory = rule.subcategory
                    t.sub_subcategory = rule.sub_subcategory
                    t.categorization_source = source
                    t.categorized_by_rule_id = rule.id
                    count += 1
            return count

        q = select(Transaction)
        if rule.rule_type == RULE_TYPE_VPA:
            q = q.where(func.lower(Transaction.vpa) == rule.rule_value)
        elif rule.rule_type == RULE_TYPE_MERCHANT:
            q = q.where(func.lower(Transaction.merchant_name) == rule.rule_value)
        elif rule.rule_type == RULE_TYPE_KEYWORD:
            q = q.where(func.lower(Transaction.description).like(f"%{rule.rule_value}%"))
        else:
            return 0

        for t in self.s.scalars(q):
            t.category               = rule.category
            t.subcategory            = rule.subcategory
            t.sub_subcategory        = rule.sub_subcategory
            t.categorization_source  = source
            t.categorized_by_rule_id = rule.id
            count += 1
        return count

    def _clear_transactions_for_rule(self, rule: CategorizationRule) -> int:
        """Clear categories on rows matched by ``rule`` (same predicate as propagate)."""
        from services.rule_engine import evaluate_conditions, _safe_json

        count = 0

        if rule.rule_type == RULE_TYPE_HEURISTIC:
            cond = _safe_json(rule.conditions_json) or {}
            if not cond:
                return 0
            for t in self.s.scalars(select(Transaction)):
                if evaluate_conditions(cond, t):
                    t.category = None
                    t.subcategory = None
                    count += 1
            return count

        q = select(Transaction)
        if rule.rule_type == RULE_TYPE_VPA:
            q = q.where(func.lower(Transaction.vpa) == rule.rule_value)
        elif rule.rule_type == RULE_TYPE_MERCHANT:
            q = q.where(func.lower(Transaction.merchant_name) == rule.rule_value)
        elif rule.rule_type == RULE_TYPE_KEYWORD:
            q = q.where(func.lower(Transaction.description).like(f"%{rule.rule_value}%"))
        else:
            return 0

        for t in self.s.scalars(q):
            t.category = None
            t.subcategory = None
            count += 1
        return count
