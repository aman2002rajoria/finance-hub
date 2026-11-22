"""Parse a PDF and persist its transactions.

Pipeline
--------
1. SHA-256 the bytes; if we've seen this file before, skip entirely.
2. Detect the bank via :func:`parsers.detect_bank`.
3. Instantiate the parser, call ``.parse()``.
4. Normalise every :class:`Transaction` into our DB schema:
   * collapse dual ``debit``/``credit`` columns → ``(amount, type)``
   * stamp ``account_type`` (savings / credit_card) from the source bank
   * pull VPA + merchant_name out of the description if the parser
     didn't already supply them
   * flag CC-payment debits via the linking-service heuristic
5. Run saved categorization rules so the rows arrive pre-tagged.
6. ``INSERT OR IGNORE`` (deterministic IDs dedupe automatically).
7. Re-run linking-service to wire savings ↔ savings transfers and
   savings → CC payment pairs across accounts.
8. Record the upload in the ``uploads`` table.
"""

from __future__ import annotations

import logging
import os
import tempfile
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from db.models import (
    ACCOUNT_TYPE_CREDIT_CARD, ACCOUNT_TYPE_SAVINGS,
    TXN_TYPE_CREDIT, TXN_TYPE_DEBIT, Account, Transaction, Upload,
)
from parsers import (
    BANK_CANARA, BANK_SBI, BANK_SBI_CC, BANK_SLICE_CC, BANK_SLICE_SAVINGS,
    CanaraParser, SBICCParser, SBIParser, SliceCCParser, SliceParser,
    detect_bank,
)
from parsers.base_parser import Transaction as ParsedTxn

from services.categorization_service import (
    CategorizationService, apply_income_autotag,
    extract_merchant_name, extract_vpa,
)
from services.dedup_service import (
    deterministic_txn_id,
    file_sha256,
    is_real_bank_reference,
)
from services.linking_service import LinkingService


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Bank-id → (parser class, canonical account_name, account_type, display_name)
# ---------------------------------------------------------------------------

BANK_REGISTRY = {
    BANK_SBI:           (SBIParser,      "SBI",      ACCOUNT_TYPE_SAVINGS,     "SBI Savings"),
    BANK_SBI_CC:        (SBICCParser,    "SBI_CC",   ACCOUNT_TYPE_CREDIT_CARD, "SBI Credit Card"),
    BANK_SLICE_SAVINGS: (SliceParser,    "SLICE",    ACCOUNT_TYPE_SAVINGS,     "Slice Savings"),
    BANK_SLICE_CC:      (SliceCCParser,  "SLICE_CC", ACCOUNT_TYPE_CREDIT_CARD, "Slice Credit Card"),
    BANK_CANARA:        (CanaraParser,   "CANARA",   ACCOUNT_TYPE_SAVINGS,     "Canara Savings"),
}


# ---------------------------------------------------------------------------
# Result object
# ---------------------------------------------------------------------------


@dataclass
class IngestionResult:
    filename: str
    bank: Optional[str] = None
    account_name: Optional[str] = None
    pages_parsed: int = 0
    parsed_count: int = 0
    new_count: int = 0
    duplicate_count: int = 0
    parse_failure_count: int = 0
    period_start: Optional[str] = None
    period_end: Optional[str] = None
    cc_payments_tagged: int = 0
    rules_applied: int = 0
    income_autotagged: int = 0
    skipped_already_uploaded: bool = False
    force_reparsed: bool = False
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class IngestionService:
    def __init__(self, session: Session) -> None:
        self.s = session
        self.cat = CategorizationService(session)
        self.linker = LinkingService(session)

    # ------------------------------------------------------------------
    # Public entry — bytes in, IngestionResult out
    # ------------------------------------------------------------------

    def ingest_pdf_bytes(
        self,
        file_bytes: bytes,
        filename: str,
        password: Optional[str] = None,
        force_bank: Optional[str] = None,
        force_reparse: bool = False,
    ) -> IngestionResult:
        result = IngestionResult(filename=filename)

        # 1. File-hash short-circuit. Allow re-parse when the prior upload
        # extracted nothing (parser bug) or the caller forces it. Transaction
        # dedupe still prevents duplicate ledger rows.
        fhash = file_sha256(file_bytes)
        prior = self.s.scalar(select(Upload).where(Upload.file_hash == fhash))
        if prior and not force_reparse and (prior.txn_count or 0) > 0:
            result.skipped_already_uploaded = True
            result.bank = prior.bank
            result.parsed_count = prior.txn_count
            result.new_count = 0
            result.duplicate_count = prior.txn_count
            result.warnings.append("File already uploaded — skipped re-parse.")
            return result
        if prior and ((prior.txn_count or 0) == 0 or force_reparse):
            result.force_reparsed = True
            result.warnings.append(
                "Re-parsing previously uploaded file "
                f"(prior txn_count={prior.txn_count}, force_reparse={force_reparse})."
            )

        # 2. Persist to temp & detect bank.
        suffix = os.path.splitext(filename)[1] or ".pdf"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(file_bytes)
            tmp_path = tmp.name
        try:
            bank_id = force_bank or detect_bank(tmp_path, password=password or "")
            if bank_id not in BANK_REGISTRY:
                result.errors.append(f"Could not detect bank (got: {bank_id!r}).")
                return result

            parser_cls, account_name, account_type, display_name = BANK_REGISTRY[bank_id]
            result.bank = bank_id
            result.account_name = account_name

            # 3. Make sure Account row exists.
            self._ensure_account(account_name, account_type, display_name)

            # 4. Run parser.
            parser_obj = parser_cls(tmp_path, password=password)
            try:
                parsed = parser_obj.parse()
            except PermissionError as exc:
                result.errors.append(str(exc))
                return result
            except Exception as exc:
                result.errors.append(f"Parser raised {type(exc).__name__}: {exc}")
                return result

            result.pages_parsed = parsed.pages_parsed
            result.parsed_count = len(parsed.transactions)
            result.parse_failure_count = len(parsed.errors)
            for err in parsed.errors[:25]:
                result.errors.append(f"p{err.page}: {err.reason} :: {err.line[:160]}")
            for w in parsed.warnings:
                if w not in result.warnings:
                    result.warnings.append(w)

            # 5. Convert to dict rows (occurrence index keeps same-day twins).
            rows = self._rows_from_parsed(
                parsed.transactions, account_name, account_type, display_name, filename
            )
            if rows:
                dates = sorted(r["date"].isoformat() for r in rows)
                result.period_start = dates[0]
                result.period_end = dates[-1]

            # 6. CC-payment flagging (savings-debit heuristic).
            result.cc_payments_tagged = self.linker.flag_cc_payments_in_dicts(rows)
            # 7a. Income auto-detection (salary/interest/cashback/refund).
            #     Runs BEFORE saved-rule application so user-defined rules
            #     can still override the heuristic for edge cases.
            #     Categorization logic itself is unchanged.
            result.income_autotagged = apply_income_autotag(rows)
            # 7b. Saved-rule application (existing rules/mappings only).
            result.rules_applied = self.cat.apply_rules_to_dicts(rows)

            # 8. Insert with dedup.
            inserted = self._insert_rows(rows)
            result.new_count = inserted
            result.duplicate_count = len(rows) - inserted

            # 9. Cross-account linking (only worth doing if we inserted rows).
            if inserted:
                self.linker.link_cc_payments()
                self.linker.detect_internal_transfers()

            # 10. Audit-trail row (update prior hash row when re-parsing).
            self._record_upload(filename, fhash, bank_id, result, prior=prior)
            return result
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _ensure_account(self, name: str, atype: str, display: str) -> Account:
        a = self.s.scalar(select(Account).where(Account.name == name))
        if a:
            return a
        a = Account(name=name, type=atype, display_name=display)
        self.s.add(a)
        self.s.flush()
        return a

    def _rows_from_parsed(
        self,
        parsed_txns: List[ParsedTxn],
        account_name: str,
        account_type: str,
        display_name: str,
        source_file: str,
    ) -> List[dict]:
        """Convert parser txns → DB dicts with stable IDs.

        Occurrence index only bumps when the base fingerprint collides
        inside this batch (two genuine twins). Existing single rows keep
        occurrence=0 so re-uploads still match the historical id.
        """
        rows: List[dict] = []
        seen_base: dict = {}
        for t in parsed_txns:
            base_key = self._fingerprint_key(t, account_name)
            occ = seen_base.get(base_key, 0)
            seen_base[base_key] = occ + 1
            rows.append(
                self._to_row(
                    t, account_name, account_type, display_name, source_file,
                    occurrence=occ,
                )
            )
        return rows

    def _fingerprint_key(self, t: ParsedTxn, account_name: str) -> Tuple:
        if t.debit and t.debit > 0:
            amount = float(t.debit)
        elif t.credit and t.credit > 0:
            amount = float(t.credit)
        else:
            amount = 0.0
        if hasattr(t.date, "date"):
            date_iso = t.date.date().isoformat()
        else:
            date_iso = str(t.date)[:10]
        return (date_iso, round(amount, 2), (t.description or "").strip().lower(), account_name)

    def _to_row(
        self,
        t: ParsedTxn,
        account_name: str,
        account_type: str,
        display_name: str,
        source_file: str,
        occurrence: int = 0,
    ) -> dict:
        # debit / credit → amount + type
        if t.debit and t.debit > 0:
            amount, ttype = float(t.debit), TXN_TYPE_DEBIT
        elif t.credit and t.credit > 0:
            amount, ttype = float(t.credit), TXN_TYPE_CREDIT
        else:
            amount, ttype = 0.0, TXN_TYPE_DEBIT

        # CC rows have no running balance — store NULL so analytics can
        # filter ``balance IS NOT NULL``.
        balance = None if account_type == ACCOUNT_TYPE_CREDIT_CARD else float(t.balance or 0.0)

        description = (t.description or "").strip()

        # The parser hands us a ``pd.Timestamp`` (or a plain ``date``).
        # Coerce to a real :class:`datetime.date` for SQLAlchemy's Date
        # column, and keep an ISO string for the deterministic ID hash.
        if hasattr(t.date, "date"):
            date_obj: date = t.date.date()  # pandas.Timestamp
        elif isinstance(t.date, datetime):
            date_obj = t.date.date()
        elif isinstance(t.date, date):
            date_obj = t.date
        else:
            date_obj = datetime.strptime(str(t.date)[:10], "%Y-%m-%d").date()
        date_iso = date_obj.isoformat()

        # Prefer parser-supplied VPA + counterparty, fall back to regex.
        vpa = (t.txn_vpa or "").strip() or extract_vpa(description)
        merchant = (
            (t.txn_counterparty or "").strip()
            or extract_merchant_name(description)
        )

        return {
            "id":                    deterministic_txn_id(
                date_iso, amount, description, account_name, occurrence=occurrence
            ),
            "date":                  date_obj,
            "description":           description,
            "amount":                round(amount, 2),
            "type":                  ttype,
            "balance":               balance,
            "account_type":          account_type,
            "account_name":          account_name,
            "reference_id":          t.txn_reference or None,
            "raw_text":              t.txn_raw_description or description,
            "vpa":                   (vpa or "").lower() or None,
            "merchant_name":         merchant or None,
            "txn_mode":              t.txn_mode or None,
            "txn_time":              None,   # parsers don't surface time today; reserved for future
            "category":              None,
            "subcategory":           None,
            "sub_subcategory":       None,
            "categorization_source": None,
            "categorized_by_rule_id": None,
            "is_refund":             False,
            "refund_category":       None,
            "is_internal_transfer":  False,
            "is_credit_card_payment": False,
            "is_emi":                False,
            "linked_transaction_id": None,
            "emi_id":                None,
            "source_file":           source_file,
        }

    def _insert_rows(self, rows: List[dict]) -> int:
        """INSERT OR IGNORE — returns count of actually-new rows.

        We dedupe in two passes:

        1. **Primary (deterministic ID)**: ``id`` is a SHA-1 of
           ``date|amount|description|account_name``. Identical PDFs
           always produce identical IDs, so this is a fast hash-set
           filter.
        2. **Secondary (reference_id match)**: when a parser yields a
           non-empty ``reference_id``, we also check
           ``(account_name, date, amount, reference_id)`` against the
           DB. This handles the awkward case where two PDFs render the
           same transaction with subtly different description text
           (e.g. extra whitespace, masked PAN trailing chars) — the
           deterministic hash would differ but the bank's reference
           number is the source of truth.
        """
        if not rows:
            return 0
        existing_ids = set(self.s.scalars(
            select(Transaction.id).where(Transaction.id.in_([r["id"] for r in rows]))
        ))
        new_rows = [r for r in rows if r["id"] not in existing_ids]
        if not new_rows:
            return 0

        # Pass 2a: strong bank reference — same account + real UTR/ref
        # means the same transaction even if description text drifted.
        strong_refs = {
            r["reference_id"]
            for r in new_rows
            if is_real_bank_reference(r.get("reference_id"))
        }
        if strong_refs:
            existing_strong = self.s.execute(
                select(Transaction.account_name, Transaction.reference_id).where(
                    Transaction.reference_id.in_(strong_refs)
                )
            ).all()
            strong_hits = {(acct, ref) for acct, ref in existing_strong}
            if strong_hits:
                new_rows = [
                    r for r in new_rows
                    if (r["account_name"], r.get("reference_id")) not in strong_hits
                ]
                if not new_rows:
                    return 0

        # Pass 2b: (account, date, amount, reference_id) for any non-empty
        # ref including synthetic CC hashes (description-stable re-uploads).
        ref_candidates = [r for r in new_rows if r.get("reference_id")]
        if ref_candidates:
            ref_pairs = {
                (r["account_name"], r["date"], round(r["amount"], 2), r["reference_id"])
                for r in ref_candidates
            }
            existing = self.s.execute(
                select(
                    Transaction.account_name,
                    Transaction.date,
                    Transaction.amount,
                    Transaction.reference_id,
                ).where(
                    Transaction.reference_id.in_({r["reference_id"] for r in ref_candidates})
                )
            ).all()
            existing_pairs = {
                (acct, d, round(float(amt), 2), ref) for acct, d, amt, ref in existing
            }
            collisions = ref_pairs & existing_pairs
            if collisions:
                new_rows = [
                    r for r in new_rows
                    if (r["account_name"], r["date"], round(r["amount"], 2), r.get("reference_id"))
                    not in collisions
                ]
                if not new_rows:
                    return 0

        # Resolve account_id once.
        account_ids: dict = {}
        for r in new_rows:
            an = r["account_name"]
            if an not in account_ids:
                a = self.s.scalar(select(Account).where(Account.name == an))
                account_ids[an] = a.id if a else None
            r["account_id"] = account_ids[an]

        # Bulk insert.
        self.s.bulk_insert_mappings(Transaction, [
            {
                "id":                     r["id"],
                "date":                   r["date"],
                "description":            r["description"],
                "amount":                 r["amount"],
                "type":                   r["type"],
                "balance":                r["balance"],
                "account_type":           r["account_type"],
                "account_id":             r["account_id"],
                "account_name":           r["account_name"],
                "reference_id":           r["reference_id"],
                "raw_text":               r["raw_text"],
                "vpa":                    r["vpa"],
                "merchant_name":          r["merchant_name"],
                "txn_mode":               r["txn_mode"],
                "txn_time":               r.get("txn_time"),
                "category":               r["category"],
                "subcategory":            r["subcategory"],
                "sub_subcategory":        r.get("sub_subcategory"),
                "categorization_source":  r.get("categorization_source"),
                "categorized_by_rule_id": r.get("categorized_by_rule_id"),
                "is_refund":              r.get("is_refund", False),
                "refund_category":        r.get("refund_category"),
                "is_internal_transfer":   r["is_internal_transfer"],
                "is_credit_card_payment": r["is_credit_card_payment"],
                "is_emi":                 r["is_emi"],
                "linked_transaction_id":  r["linked_transaction_id"],
                "emi_id":                 r["emi_id"],
                "source_file":            r["source_file"],
            }
            for r in new_rows
        ])
        self.s.commit()
        return len(new_rows)

    def _record_upload(
        self,
        filename: str,
        file_hash: str,
        bank_id: str,
        result: IngestionResult,
        prior: Optional[Upload] = None,
    ) -> None:
        notes = "; ".join(result.warnings) if result.warnings else None
        if prior is not None:
            prior.filename = os.path.basename(filename)
            prior.bank = bank_id
            prior.txn_count = result.parsed_count
            prior.new_txn_count = result.new_count
            prior.pages_parsed = result.pages_parsed
            prior.notes = notes
            self.s.commit()
            return
        u = Upload(
            filename=os.path.basename(filename),
            file_hash=file_hash,
            bank=bank_id,
            txn_count=result.parsed_count,
            new_txn_count=result.new_count,
            pages_parsed=result.pages_parsed,
            notes=notes,
        )
        self.s.add(u)
        self.s.commit()
