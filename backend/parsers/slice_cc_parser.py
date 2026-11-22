"""Slice — Credit Card monthly statement parser.

Why a SEPARATE parser (not an extension of ``slice_parser``)?
-------------------------------------------------------------
The Slice savings statement and the Slice credit-card statement share
nothing structural beyond the bank's name. Reusing the savings parser
would actively mislead the user, so this module is intentionally
isolated.

Observed structure of the CC statement
--------------------------------------
The PDF layout is a series of **3-line triplets** (one per transaction)
grouped under section headers that determine the credit/debit type::

    Spends                          ← section header → following rows are DEBITS
    Blinkit 486                     ← L1: <merchant> <amount>
    ₹                               ← L2: rupee glyph (sometimes prefixed
                                          with the merchant's first-letter
                                          avatar, e.g. "T ₹")
    19 Apr '26 • UPI                ← L3: date  [• payment-method]
    Swiggy 250
    ₹
    18 Apr '26 • UPI
    …
    Refunds & repayments            ← section header → following rows are CREDITS
    Zomato 355.43
    ₹
    2 Apr '26
    Cashback                        ← section header → following rows are CREDITS
    Swiggy 50
    ₹
    18 Apr '26
    …
    GST details / monies / Glossary ← STOP (no more transaction triplets)

Page 1 is a summary block (Spends/Refunds/etc with totals, no triplets
with real dates). Pages 8-10 are glossary boilerplate. Both are skipped
naturally because we require L3 to match a real ``DD Mon 'YY`` date — a
much stronger signal than enumerating noise lines.

Schema notes
------------
* ``balance`` is set to ``0.0`` for every CC row — a credit-card
  statement has no per-transaction running balance, and the unified
  schema needs a float (not NULL). The ``Source`` column makes the
  difference clear in downstream analytics.
* ``txn_reference`` is a stable SHA-1 hash of (date, merchant, amount).
  CC statements have no native reference number; the hash gives
  deterministic dedupe keys across re-uploads.
* ``txn_mode`` reflects the **section** (``Spend``/``Refund``/
  ``Cashback``/``Charge``) so analytics can categorise rows cleanly.
* ``txn_counterparty`` is the merchant name (the L1 text before the
  amount). Multi-word merchants ("Trolleypop retail") are preserved
  verbatim.
"""

from __future__ import annotations

import hashlib
import logging
import re
from typing import List, Optional, Tuple

import pandas as pd
import pdfplumber

from parsers.base_parser import (
    BaseParser,
    DebugRow,
    ParseError,
    ParseResult,
    Transaction,
)
from utils.regex_utils import SLICE_DATE_REGEX, slice_date_to_iso
from utils.text_cleaner import normalize_text


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Patterns
# ---------------------------------------------------------------------------

# Trailing amount on the L1 of a transaction triplet. Anchored at end of
# line; allows Indian-grouped commas (``1,810``, ``19,375``) and an
# optional ``.dd`` decimal tail (``334.95``, ``2,062.02``).
_AMOUNT_AT_END_RE = re.compile(
    r"(?P<amt>\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?)\s*$"
)

# Layout B (Jan–Mar 2026 style): merchant + ₹amount on one line.
# Example: ``SHUDH DAIRY ₹240`` / ``S`` / ``20 Mar '26 • UPI``.
_MERCHANT_INR_AMT_RE = re.compile(
    r"^(?P<merch>.+?)\s*₹\s*(?P<amt>\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?)\s*$"
)

# L2 of a triplet is either the bare rupee glyph or a single uppercase
# letter (the merchant-initial avatar) followed by the glyph.  We allow
# extra whitespace and trailing characters because pdfplumber sometimes
# inserts paise-fragments here (e.g. "₹ .54" on the page-1 headline) —
# checking with ``in`` keeps the matcher tolerant.
_RUPEE_LINE_RE = re.compile(r"^[A-Z]?\s*₹")

# Layout B avatar line: a single uppercase letter (merchant initial).
_AVATAR_LINE_RE = re.compile(r"^[A-Z]$")

# L3 of a triplet always starts with a Slice date. The optional
# ``• <method>`` suffix only appears in the Spends section (UPI / Card);
# Refunds & Cashback sections print just the date.
_METHOD_RE = re.compile(r"•\s*(\w+)", re.IGNORECASE)

# Page-1 summary labels → attribute on StatementSummary.
_SUMMARY_LABEL_RE = re.compile(
    r"^\s*(?P<label>Spends|Refunds?\s*&\s*repayments?|Cashback|Interest|Surcharge|"
    r"Total amount due|Min amount due)\s*(?:₹\s*(?P<inline>[\d,]+(?:\.\d{1,2})?))?\s*$",
    re.IGNORECASE,
)
_SUMMARY_INR_ONLY_RE = re.compile(
    r"^\s*₹\s*(?P<amt>[\d,]+(?:\.\d{1,2})?)\s*$"
)
_SUMMARY_BARE_AMT_RE = re.compile(
    r"^\s*(?P<amt>\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?)\s*$"
)


# ---------------------------------------------------------------------------
# Section state machine
# ---------------------------------------------------------------------------

# Section-header lines → (section_key, direction)
# ``direction == "credit"`` means rows under this section increase
# balance for the user; ``debit`` means they increase amount-due.
_SECTION_HEADERS: List[Tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"^\s*spends\s*$", re.IGNORECASE),                 "Spend",     "debit"),
    (re.compile(r"^\s*refunds?\s*&\s*repayments?\s*$", re.IGNORECASE), "Refund",    "credit"),
    (re.compile(r"^\s*cashback\s*$", re.IGNORECASE),               "Cashback",  "credit"),
    (re.compile(r"^\s*bank\s+transfers?\s*$", re.IGNORECASE),      "Transfer",  "debit"),
    (re.compile(r"^\s*interest\s*$", re.IGNORECASE),               "Interest",  "debit"),
    (re.compile(r"^\s*surcharge\s*$", re.IGNORECASE),              "Surcharge", "debit"),
    (re.compile(r"^\s*late\s+fee\s*$", re.IGNORECASE),             "LateFee",   "debit"),
    (re.compile(r"^\s*flat\s+fee\s*$", re.IGNORECASE),             "FlatFee",   "debit"),
    (re.compile(r"^\s*foreclosure\s+charge\s*$", re.IGNORECASE),   "Foreclosure", "debit"),
    (re.compile(r"^\s*ongoing\s+emis?\s*$", re.IGNORECASE),        "EMI",       "debit"),
    (re.compile(r"^\s*carry\s+forward\s*$", re.IGNORECASE),        "CarryForward", "debit"),
]

# Hard stop markers — anything after one of these is GST breakdown,
# rewards summary, or glossary text, not transactions.
_STOP_MARKERS: List[re.Pattern[str]] = [
    re.compile(r"^\s*gst\s+details\s*$", re.IGNORECASE),
    re.compile(r"^\s*monies\s*$", re.IGNORECASE),
    re.compile(r"^\s*glossary\s*$", re.IGNORECASE),
    re.compile(r"^\s*payment\s+obligations\s*$", re.IGNORECASE),
    re.compile(r"^\s*credit\s+card\s+security\s*$", re.IGNORECASE),
    re.compile(r"^\s*grievance\s+redressal\s*$", re.IGNORECASE),
]


def _is_stop_marker(line: str) -> bool:
    return any(p.match(line) for p in _STOP_MARKERS)


def _match_section(line: str) -> Optional[Tuple[str, str]]:
    """Return ``(section_label, direction)`` if ``line`` is a section header."""
    for pat, label, direction in _SECTION_HEADERS:
        if pat.match(line):
            return label, direction
    return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_amount(tok: str) -> Optional[float]:
    """Parse ``"19,379.44"`` → 19379.44. Returns ``None`` on failure."""
    if not tok:
        return None
    try:
        return float(tok.replace(",", ""))
    except (TypeError, ValueError):
        return None


def _hash_ref(date_iso: str, merchant: str, amount: float) -> str:
    """Deterministic synthetic reference for a CC row.

    SHA-1 is overkill for a personal statement but gives a collision-safe
    10-char hex prefix that can survive dedupe across re-uploads of the
    same PDF (same inputs → same hash).
    """
    seed = f"{date_iso}|{merchant.strip().lower()}|{amount:.2f}"
    return "CC-" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:10].upper()


def _split_clean_lines(raw_text: str) -> List[str]:
    """Split + normalise + drop empties. Kept inline (not from text_cleaner)
    so the CC parser is fully self-contained against future Slice-savings
    cleaner tweaks."""
    if not raw_text:
        return []
    out: List[str] = []
    for raw in raw_text.split("\n"):
        cleaned = normalize_text(raw).strip()
        if cleaned:
            out.append(cleaned)
    return out


# ---------------------------------------------------------------------------
# Triplet walker  (one transaction = three consecutive lines)
# ---------------------------------------------------------------------------


def _build_txn(
    merchant: str,
    amount: float,
    date_line: str,
    section_label: str,
    direction: str,
    source_file: str,
    page_idx: int,
    raw_parts: List[str],
    layout: str,
) -> Tuple[Optional[Transaction], Optional[DebugRow]]:
    """Build a :class:`Transaction` from merchant/amount/date pieces."""
    merchant = re.sub(r"\s+", " ", (merchant or "").strip())
    if not merchant:
        merchant = section_label

    dm = SLICE_DATE_REGEX.match(date_line)
    if not dm:
        return None, None
    date_iso = slice_date_to_iso(dm.group(1), dm.group(2), dm.group(3))
    if date_iso is None:
        return None, None
    date_ts = pd.Timestamp(date_iso)

    method_match = _METHOD_RE.search(date_line)
    method = method_match.group(1).strip() if method_match else None

    desc_bits = [merchant]
    if method:
        desc_bits.append(f"({method})")
    description = " ".join(desc_bits)

    debit_val = float(amount) if direction == "debit" else 0.0
    credit_val = 0.0 if direction == "debit" else float(amount)
    reference = _hash_ref(date_iso, merchant, amount)

    mode_parts = [f"CC-{section_label}"]
    if method:
        mode_parts.append(method)
    txn_mode = "/".join(mode_parts)
    raw_text = " | ".join(raw_parts)

    txn = Transaction(
        date=date_ts,
        description=description,
        debit=debit_val,
        credit=credit_val,
        balance=0.0,
        source="Slice-CC",
        source_file=source_file,
        txn_mode=txn_mode,
        txn_reference=reference,
        txn_vpa=None,
        txn_counterparty=merchant,
        txn_bank=None,
        txn_phone=None,
        txn_raw_description=raw_text,
    )
    dbg = DebugRow(
        page=page_idx,
        raw=raw_text,
        tokens=list(raw_parts),
        decision=(
            f"slice-cc/{layout}: section={section_label} dir={direction} "
            f"amt={amount} method={method or '-'} -> "
            f"{'DR' if direction == 'debit' else 'CR'}"
        ),
        date=dm.group(0),
        debit=debit_val,
        credit=credit_val,
        balance=0.0,
    )
    return txn, dbg


def _build_triplet_transaction(
    L1: str,
    L2: str,
    L3: str,
    section_label: str,
    direction: str,
    source_file: str,
    page_idx: int,
) -> Tuple[Optional[Transaction], Optional[DebugRow]]:
    """Layout A: ``Merchant 486`` / ``₹`` / ``19 Apr '26 • UPI``."""
    amt_match = _AMOUNT_AT_END_RE.search(L1)
    if not amt_match:
        return None, None
    amount = _parse_amount(amt_match.group("amt"))
    if amount is None:
        return None, None
    merchant = L1[: amt_match.start()].rstrip(" •|-\t")
    return _build_txn(
        merchant, amount, L3, section_label, direction,
        source_file, page_idx, [L1, L2, L3], "layout-a",
    )


def _build_layout_b_transaction(
    L1: str,
    L2: str,
    L3: str,
    section_label: str,
    direction: str,
    source_file: str,
    page_idx: int,
) -> Tuple[Optional[Transaction], Optional[DebugRow]]:
    """Layout B: ``MERCHANT ₹240`` / ``S`` / ``20 Mar '26 • UPI``."""
    m = _MERCHANT_INR_AMT_RE.match(L1)
    if not m:
        return None, None
    amount = _parse_amount(m.group("amt"))
    if amount is None:
        return None, None
    return _build_txn(
        m.group("merch"), amount, L3, section_label, direction,
        source_file, page_idx, [L1, L2, L3], "layout-b",
    )


def _build_two_line_credit(
    L1: str,
    L2: str,
    section_label: str,
    direction: str,
    source_file: str,
    page_idx: int,
) -> Tuple[Optional[Transaction], Optional[DebugRow]]:
    """Credit variant without avatar: ``Repayment ₹50`` / ``29 Dec '25``."""
    m = _MERCHANT_INR_AMT_RE.match(L1)
    if not m:
        return None, None
    amount = _parse_amount(m.group("amt"))
    if amount is None:
        return None, None
    return _build_txn(
        m.group("merch"), amount, L2, section_label, direction,
        source_file, page_idx, [L1, L2], "layout-b-2line",
    )


def _walk_lines(
    tagged_lines: List[Tuple[int, str]],
    source_file: str,
) -> Tuple[List[Transaction], List[ParseError], List[DebugRow]]:
    """State-machine walk over every line, emitting one txn per triplet.

    Three state variables:
        * ``current_section`` — last seen section header label (or None
          until we've seen "Spends" on page 2). Drives credit/debit.
        * ``direction`` — paired with ``current_section``.
        * ``stopped`` — once we hit a STOP marker we ignore everything.

    The triplet detector is greedy from the left: when (L1 has trailing
    amount, L2 has ₹, L3 has date) we emit and skip ahead by 3. When
    any check fails we advance by 1 and re-try — that way an extra
    decorative line between sections never desynchronises us.
    """
    txns: List[Transaction] = []
    errors: List[ParseError] = []
    debug: List[DebugRow] = []

    current_section: Optional[str] = None
    direction: Optional[str] = None
    stopped = False

    i = 0
    n = len(tagged_lines)
    while i < n:
        page_idx, line = tagged_lines[i]

        if stopped:
            break

        if _is_stop_marker(line):
            stopped = True
            break

        # Section header? Update state and consume the line.
        sec = _match_section(line)
        if sec is not None:
            current_section, direction = sec
            i += 1
            continue

        # Need an active section to emit transactions.
        if current_section is None or direction is None:
            i += 1
            continue

        # Layout A: Merchant 486 / ₹ / 19 Apr '26 • UPI
        if i + 2 < n:
            L2 = tagged_lines[i + 1][1]
            L3 = tagged_lines[i + 2][1]
            if (
                _AMOUNT_AT_END_RE.search(line)
                and _RUPEE_LINE_RE.match(L2)
                and SLICE_DATE_REGEX.match(L3)
                and not _MERCHANT_INR_AMT_RE.match(line)
            ):
                txn, dbg = _build_triplet_transaction(
                    line, L2, L3,
                    current_section, direction,
                    source_file, page_idx,
                )
                if txn is not None:
                    txns.append(txn)
                    if dbg is not None:
                        debug.append(dbg)
                    i += 3
                    continue
                errors.append(
                    ParseError(
                        page_idx,
                        f"{line} | {L2} | {L3}",
                        "layout-a triplet matched shape but failed to build txn",
                    )
                )
                i += 3
                continue

            # Layout B: MERCHANT ₹240 / S / 20 Mar '26 • UPI
            if (
                _MERCHANT_INR_AMT_RE.match(line)
                and _AVATAR_LINE_RE.match(L2)
                and SLICE_DATE_REGEX.match(L3)
            ):
                txn, dbg = _build_layout_b_transaction(
                    line, L2, L3,
                    current_section, direction,
                    source_file, page_idx,
                )
                if txn is not None:
                    txns.append(txn)
                    if dbg is not None:
                        debug.append(dbg)
                    i += 3
                    continue
                errors.append(
                    ParseError(
                        page_idx,
                        f"{line} | {L2} | {L3}",
                        "layout-b triplet matched shape but failed to build txn",
                    )
                )
                i += 3
                continue

        # Two-line credit (no avatar): Repayment ₹50 / 29 Dec '25
        if (
            i + 1 < n
            and direction == "credit"
            and _MERCHANT_INR_AMT_RE.match(line)
            and SLICE_DATE_REGEX.match(tagged_lines[i + 1][1])
        ):
            L2 = tagged_lines[i + 1][1]
            txn, dbg = _build_two_line_credit(
                line, L2, current_section, direction, source_file, page_idx,
            )
            if txn is not None:
                txns.append(txn)
                if dbg is not None:
                    debug.append(dbg)
                i += 2
                continue
            errors.append(
                ParseError(
                    page_idx,
                    f"{line} | {L2}",
                    "two-line credit matched shape but failed to build txn",
                )
            )
            i += 2
            continue

        # Likely txn-shaped line we could not classify — surface it.
        if _MERCHANT_INR_AMT_RE.match(line) or (
            _AMOUNT_AT_END_RE.search(line)
            and not _SUMMARY_BARE_AMT_RE.match(line)
            and current_section is not None
        ):
            peek = tagged_lines[i + 1][1] if i + 1 < n else ""
            peek2 = tagged_lines[i + 2][1] if i + 2 < n else ""
            if SLICE_DATE_REGEX.match(peek) or SLICE_DATE_REGEX.match(peek2) or _AVATAR_LINE_RE.match(peek):
                errors.append(
                    ParseError(
                        page_idx,
                        f"{line} | {peek} | {peek2}".strip(" |"),
                        "looks like a transaction but did not match a known Slice CC layout",
                    )
                )

        i += 1

    return txns, errors, debug


def _extract_statement_summary(lines: List[str]) -> dict:
    """Pull page-1 Spends/Refunds/Cashback/… totals when present."""
    out = {
        "spends": None,
        "refunds": None,
        "cashback": None,
        "interest": None,
        "surcharge": None,
        "total_due": None,
        "min_due": None,
    }
    label_map = {
        "spends": "spends",
        "refunds & repayments": "refunds",
        "refund & repayments": "refunds",
        "cashback": "cashback",
        "interest": "interest",
        "surcharge": "surcharge",
        "total amount due": "total_due",
        "min amount due": "min_due",
    }
    i = 0
    while i < len(lines):
        m = _SUMMARY_LABEL_RE.match(lines[i])
        if not m:
            i += 1
            continue
        key = label_map.get(re.sub(r"\s+", " ", m.group("label").strip().lower()))
        if not key:
            i += 1
            continue
        amt = _parse_amount(m.group("inline") or "")
        # April layout: Spends / ₹ / 19,379.44
        if amt is None and i + 2 < len(lines):
            if _RUPEE_LINE_RE.match(lines[i + 1]) and _SUMMARY_BARE_AMT_RE.match(lines[i + 2]):
                amt = _parse_amount(_SUMMARY_BARE_AMT_RE.match(lines[i + 2]).group("amt"))
                i += 2
        # Or: Spends / ₹12,345.67
        if amt is None and i + 1 < len(lines):
            m_inr = _SUMMARY_INR_ONLY_RE.match(lines[i + 1])
            if m_inr:
                amt = _parse_amount(m_inr.group("amt"))
                i += 1
        if amt is not None:
            out[key] = amt
        i += 1
    return out


def _reconcile_summary(txns: List[Transaction], summary: dict) -> List[str]:
    """Flag statement-total vs parsed-sum mismatches (do not drop rows)."""
    warnings: List[str] = []
    debit = round(sum(t.debit for t in txns), 2)
    credit = round(sum(t.credit for t in txns), 2)
    spends = summary.get("spends")
    refunds = summary.get("refunds")
    cashback = summary.get("cashback")
    if spends is not None and abs(debit - float(spends)) > 0.05:
        warnings.append(
            f"Reconciliation: parsed debits ₹{debit:.2f} != statement Spends ₹{float(spends):.2f}"
        )
    credit_expected = None
    if refunds is not None or cashback is not None:
        credit_expected = round(float(refunds or 0) + float(cashback or 0), 2)
        # Credits under Refund/Cashback sections only — Interest etc. also credit.
        credit_refundish = round(
            sum(
                t.credit for t in txns
                if (t.txn_mode or "").startswith("CC-Refund")
                or (t.txn_mode or "").startswith("CC-Cashback")
            ),
            2,
        )
        if abs(credit_refundish - credit_expected) > 0.05:
            warnings.append(
                f"Reconciliation: parsed refunds+cashback ₹{credit_refundish:.2f} "
                f"!= statement ₹{credit_expected:.2f}"
            )
    if summary.get("spends") is not None:
        warnings.append(
            f"Statement summary: Spends=₹{float(spends):.2f} "
            f"Refunds=₹{float(refunds or 0):.2f} "
            f"Cashback=₹{float(cashback or 0):.2f} | "
            f"Parsed debit=₹{debit:.2f} credit=₹{credit:.2f}"
        )
    return warnings


# ---------------------------------------------------------------------------
# Public parser
# ---------------------------------------------------------------------------


class SliceCCParser(BaseParser):
    """Parse a Slice credit-card monthly statement PDF."""

    BANK_NAME = "Slice-CC"

    def parse_pdf(self) -> ParseResult:
        result = ParseResult(source_file=self.source_file)

        try:
            pdf = pdfplumber.open(self.file_path, password=self.password or "")
        except Exception as exc:  # noqa: BLE001
            msg = str(exc).lower()
            if "password" in msg or "decrypt" in msg or "encrypted" in msg:
                raise PermissionError(
                    "Slice CC PDF is password-protected. Provide the password and retry."
                ) from exc
            raise

        tagged_lines: List[Tuple[int, str]] = []
        try:
            for page_idx, page in enumerate(pdf.pages, start=1):
                try:
                    txt = page.extract_text() or ""
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Slice CC: extract_text failed on page %d: %s",
                                   page_idx, exc)
                    continue
                for ln in _split_clean_lines(txt):
                    tagged_lines.append((page_idx, ln))
                result.pages_parsed += 1
        finally:
            pdf.close()

        if not tagged_lines:
            result.warnings.append(
                "No text extracted from the PDF. The file may be scanned (image-only)."
            )
            return result

        txns, errors, debug = _walk_lines(tagged_lines, self.source_file)
        result.transactions.extend(txns)
        result.errors.extend(errors)
        result.debug.extend(debug)

        summary = _extract_statement_summary([ln for _, ln in tagged_lines])
        result.warnings.extend(_reconcile_summary(result.transactions, summary))

        if not result.transactions:
            result.warnings.append(
                "No transactions extracted. The PDF may be a non-standard "
                "Slice CC layout — please report it for parser tuning."
            )
        elif result.errors:
            result.warnings.append(
                f"{len(result.errors)} line group(s) looked like transactions "
                "but failed to parse — see parse errors."
            )

        # Sort by date ASC; Python's stable sort preserves source order
        # on ties so the printed reverse-chronological grouping within a
        # day is preserved as it appears in the PDF.
        result.transactions.sort(key=lambda t: t.date)
        return result
