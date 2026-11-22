"""SBI Credit Card monthly statement parser.

Why a SEPARATE parser (not an extension of ``sbi_parser``)?
-----------------------------------------------------------
SBI's *savings* statements and *credit-card* statements share nothing
structural beyond the issuing brand name. The CC statement is issued by
"SBI Cards and Payment Services Limited" (a subsidiary) and uses a
completely different layout. Sharing code would actively mislead, so
this module is intentionally isolated.

Observed structure of the CC statement
--------------------------------------
The PDF is **noise-dense**: 7 pages total, but transactions live ONLY
on page 1, between two very explicit text markers::

    Date Transaction Details Amount ( ` )       ← START marker
    for Statement Period: 06 Jun 25 to 05 Jul 25
    20 Jun 25 PAYMENT RECEIVED <ref> 51.00 C
    FORGN CURR MARKUP DB (EXCL TAX 6.71) 37.30 D       ← undated fee row
    IGST DB @ 18.00% 6.71 D                            ← undated tax row
    TRANSACTIONS FOR ROHAN MEHTA                      ← sub-header (not a txn)
    10 Jun 25 ZUDIO A UNIT OF TRENT DELHI IN 3,203.00 D
    22 Jun 25 NEW DELHI AIRPORT DOME NEW DELHI IN 2.00 D
    03 Jul 25 foodpanda*85 tu C ( sh Taipei TW 633.00 TWD 1,874.18 D
    Transactions highlighted in grey color, …          ← STOP marker

Pages 2-7 are pure T&C / disclaimers / glossary; they contain zero
real transactions. The two-marker approach gives us a hard parsing
window and lets the parser ignore everything else completely.

Two row shapes
~~~~~~~~~~~~~~
* **Dated**:   ``DD Mon YY  <desc>  <amount>  <C|D>``
* **Undated**: ``<desc>  <amount>  <C|D>``    (fee/tax row attached
  to the preceding dated transaction — typically forex markup +
  matching IGST.)

The trailing ``C`` / ``D`` token is the **absolute source of truth**
for direction. We do not need to fall back to keyword inference
(``PAYMENT``, ``REFUND`` etc.) because the bank prints the direction
explicitly on every row.

Forex rows
~~~~~~~~~~
Foreign-currency transactions append the original amount + ISO code
before the INR amount::

    03 Jul 25 foodpanda*85 tu C ( sh Taipei TW 633.00 TWD 1,874.18 D
                                              ───────── ──── ──────── ─
                                              forex amt  ccy  INR      dir

The parser always picks the **last** ``<amount> <C|D>`` pair on the
line, so the forex prefix lands in the description (where it belongs)
and the INR figure is correctly captured as the transaction amount.

Schema notes
------------
* ``balance = 0.0`` — credit cards have no per-row running balance.
* ``txn_reference`` — extracted from the description when an SBI
  payment-receipt code (``BIC5QMD0O14G4A``-style alphanumeric run) is
  present; otherwise a deterministic SHA-1 hash of (date | desc |
  amount) prefixed ``SBICC-``.
* ``txn_mode`` — derived from description keywords:
  ``CC-Payment`` / ``CC-Refund`` / ``CC-Forex`` / ``CC-Tax`` /
  ``CC-EMI`` / ``CC-Spend``.
* Undated rows inherit the date of the **most recent dated row**. For
  the very-first row (no preceding date) we fall back to the
  statement date parsed from the page-1 header.
"""

from __future__ import annotations

import hashlib
import logging
import re
from datetime import datetime
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
from utils.text_cleaner import normalize_text


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Patterns
# ---------------------------------------------------------------------------

# Dated transaction row.  Captures:
#   (1) date    — "DD Mon YY"  e.g. "20 Jun 25"
#   (2) desc    — everything in the middle (lazy match)
#   (3) amount  — last "₹"-style amount on the line  e.g. "1,874.18"
#   (4) dir     — single C/D suffix
# Note: we anchor ``$`` strictly so trailing whitespace doesn't matter.
_DATED_ROW_RE = re.compile(
    r"^(?P<date>\d{1,2}\s+[A-Za-z]{3}\s+\d{2})\s+"
    r"(?P<desc>.+?)\s+"
    r"(?P<amount>\d{1,3}(?:,\d{2,3})*(?:\.\d{2}))\s+"
    r"(?P<dir>[CD])\s*$"
)

# Undated fee/tax row (no leading date). Same captures except for date.
_UNDATED_ROW_RE = re.compile(
    r"^(?P<desc>.+?)\s+"
    r"(?P<amount>\d{1,3}(?:,\d{2,3})*(?:\.\d{2}))\s+"
    r"(?P<dir>[CD])\s*$"
)

# Statement-date header (used as fallback for undated rows that appear
# before any dated row). The actual line on page 1 is:
#   "75,000.00 8,333.00 05 Jul 2025"   (Credit Limit / Cash Limit / Stmt Date)
# but the marker we search for is the literal "Statement Date" label that
# appears two lines above the value. We just grab the next DD Mon YYYY
# fragment found anywhere in the first 30 lines.
_STATEMENT_DATE_RE = re.compile(r"\b(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\b")

# Hard section boundaries — both anchored as substring matches because
# the surrounding whitespace varies between rendered versions of the PDF.
_START_MARKER_RE = re.compile(r"Date\s+Transaction\s+Details\s+Amount", re.IGNORECASE)
_END_MARKER_RE = re.compile(r"Transactions\s+highlighted\s+in\s+grey", re.IGNORECASE)

# Lines that SIT INSIDE the transaction window but are NOT transactions
# (sub-headers, period-marker lines). We drop them silently — they would
# otherwise produce false negatives in the date / undated regexes.
_INTRA_NOISE_RE = re.compile(
    r"^(?:"
    r"for\s+statement\s+period\b"          # "for Statement Period: 06 Jun 25 to 05 Jul 25"
    r"|TRANSACTIONS\s+FOR\b"               # "TRANSACTIONS FOR ROHAN MEHTA"
    r"|Date\s+Transaction\s+Details\b"     # the header row itself
    r")",
    re.IGNORECASE,
)

# Reference extraction: SBI tags payment receipts with a long
# alphanumeric run (e.g. "000000000BIC5QMD0O14G4A"). 14+ characters,
# digits and uppercase letters only. Anchored on a word boundary so we
# don't accidentally grab parts of a merchant name.
_PAYMENT_REF_RE = re.compile(r"\b([A-Z0-9]{14,})\b")

# Category classifier — order matters (first match wins).
_CATEGORY_PATTERNS: List[Tuple[str, re.Pattern[str]]] = [
    ("CC-Payment", re.compile(r"\bpayment\s+received\b|\bpayment\b", re.IGNORECASE)),
    ("CC-Refund",  re.compile(r"\brefund\b|\breversal\b|\bcashback\b", re.IGNORECASE)),
    ("CC-EMI",     re.compile(r"\bEMI\b|\bflexipay\b|\bencash\b", re.IGNORECASE)),
    ("CC-Tax",     re.compile(r"\b(IGST|CGST|SGST|GST)\b", re.IGNORECASE)),
    ("CC-Forex",   re.compile(r"\b(FORGN|FOREIGN|MARKUP|FX)\b", re.IGNORECASE)),
    ("CC-Fee",     re.compile(r"\bfee\b|\bcharge\b|\bsurcharge\b|\bfinance\s+charge\b", re.IGNORECASE)),
    ("CC-Interest", re.compile(r"\binterest\b", re.IGNORECASE)),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_dd_mon_yy(token: str) -> Optional[pd.Timestamp]:
    """Parse ``"20 Jun 25"`` → ``pd.Timestamp('2025-06-20')``.

    SBI CC statements always use two-digit years; we treat them as
    21st-century (``25`` → 2025). Returns ``None`` on failure so the
    caller can fall back gracefully.
    """
    if not token:
        return None
    try:
        return pd.Timestamp(datetime.strptime(token.strip(), "%d %b %y"))
    except (ValueError, TypeError):
        return None


def _parse_dd_mon_yyyy(token: str) -> Optional[pd.Timestamp]:
    """Parse ``"05 Jul 2025"`` (statement-date format) → Timestamp."""
    if not token:
        return None
    try:
        return pd.Timestamp(datetime.strptime(token.strip(), "%d %b %Y"))
    except (ValueError, TypeError):
        return None


def _parse_amount(token: str) -> Optional[float]:
    """Parse ``"1,874.18"`` → 1874.18 (Indian grouping). Returns None on failure."""
    if not token:
        return None
    try:
        return float(token.replace(",", ""))
    except (TypeError, ValueError):
        return None


def _categorise(description: str) -> str:
    """Return the coarse category for ``txn_mode``. Defaults to ``CC-Spend``."""
    for label, pattern in _CATEGORY_PATTERNS:
        if pattern.search(description):
            return label
    return "CC-Spend"


def _extract_reference(description: str, date_iso: str, amount: float) -> str:
    """Extract a stable reference for this transaction.

    Priority:
        1. SBI payment-receipt code (long uppercase alphanumeric run).
        2. SHA-1 hash of ``(date_iso | description | amount)`` prefixed
           ``SBICC-``. Stable across re-uploads of the same PDF so dedupe
           keys remain consistent.
    """
    # Skip the leading "PAYMENT RECEIVED" / "TRANSACTION" boilerplate
    # words when looking for the receipt code — they're not refs.
    candidates = [
        m.group(1) for m in _PAYMENT_REF_RE.finditer(description)
        if m.group(1).upper() not in {"PAYMENT", "RECEIVED", "MARKUP", "TRANSACTION"}
    ]
    if candidates:
        # Prefer the LONGEST candidate (SBI receipt codes are typically
        # 18-24 chars, longer than incidental ALL-CAPS merchant names).
        candidates.sort(key=len, reverse=True)
        return candidates[0]

    seed = f"{date_iso}|{description.strip().lower()}|{amount:.2f}"
    return "SBICC-" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:10].upper()


def _split_clean_lines(raw_text: str) -> List[str]:
    """Split + Unicode-normalise + drop empty lines."""
    if not raw_text:
        return []
    out: List[str] = []
    for raw in raw_text.split("\n"):
        cleaned = normalize_text(raw).strip()
        if cleaned:
            out.append(cleaned)
    return out


# ---------------------------------------------------------------------------
# Row builder
# ---------------------------------------------------------------------------


def _build_transaction(
    date_ts: pd.Timestamp,
    description: str,
    amount: float,
    direction: str,
    page_idx: int,
    raw_line: str,
    source_file: str,
    date_inherited: bool,
) -> Tuple[Transaction, DebugRow]:
    """Build the Transaction + matching DebugRow for one parsed row."""
    desc_clean = re.sub(r"\s+", " ", description).strip().strip(" -|\t")
    if not desc_clean:
        desc_clean = f"SBI CC transaction {date_ts.date().isoformat()}"

    is_debit = direction.upper() == "D"
    debit_val = float(amount) if is_debit else 0.0
    credit_val = 0.0 if is_debit else float(amount)

    iso = date_ts.date().isoformat()
    reference = _extract_reference(desc_clean, iso, amount)
    mode = _categorise(desc_clean)

    txn = Transaction(
        date=date_ts,
        description=desc_clean,
        debit=debit_val,
        credit=credit_val,
        balance=0.0,  # CC has no running balance — documented in module docstring
        source="SBI-CC",
        source_file=source_file,
        txn_mode=mode,
        txn_reference=reference,
        txn_vpa=None,
        txn_counterparty=None,
        txn_bank=None,
        txn_phone=None,
        txn_raw_description=raw_line,
    )

    inherit_tag = " (date inherited)" if date_inherited else ""
    decision = (
        f"sbi-cc: dir={direction.upper()} amt={amount} mode={mode} "
        f"ref={reference}{inherit_tag}"
    )
    dbg = DebugRow(
        page=page_idx,
        raw=raw_line,
        tokens=[raw_line],
        decision=decision,
        date=date_ts.date().isoformat(),
        debit=debit_val,
        credit=credit_val,
        balance=0.0,
    )
    return txn, dbg


# ---------------------------------------------------------------------------
# Page walker
# ---------------------------------------------------------------------------


def _extract_statement_date(lines: List[str]) -> Optional[pd.Timestamp]:
    """Find the statement-date header value on page 1.

    SBI prints it as ``... 05 Jul 2025`` on the line right after the
    ``Statement Date`` label. We just scan the first ~30 lines for any
    ``DD Mon YYYY`` token (full 4-digit year) — the CC PDF only ever
    has one in this range, namely the statement date.
    """
    for ln in lines[:30]:
        m = _STATEMENT_DATE_RE.search(ln)
        if m:
            ts = _parse_dd_mon_yyyy(m.group(1))
            if ts is not None:
                return ts
    return None


def _walk_lines(
    lines: List[str],
    statement_date: Optional[pd.Timestamp],
    source_file: str,
    page_idx: int,
) -> Tuple[List[Transaction], List[ParseError], List[DebugRow]]:
    """Walk one page's lines and produce transactions.

    The walker is gated by the START / STOP markers — only lines BETWEEN
    them are considered transaction candidates. This is the single
    biggest noise filter and the reason the parser ignores 99% of the
    PDF content automatically.
    """
    txns: List[Transaction] = []
    errors: List[ParseError] = []
    debug: List[DebugRow] = []

    in_section = False
    last_date: Optional[pd.Timestamp] = None

    for line in lines:
        if not in_section:
            if _START_MARKER_RE.search(line):
                in_section = True
            continue

        # Inside the transaction section now.
        if _END_MARKER_RE.search(line):
            break

        if _INTRA_NOISE_RE.match(line):
            continue

        # Try the dated pattern first (more specific).
        m = _DATED_ROW_RE.match(line)
        if m:
            date_ts = _parse_dd_mon_yy(m.group("date"))
            if date_ts is None:
                errors.append(ParseError(
                    page_idx, line, f"bad date token: {m.group('date')!r}",
                ))
                continue
            amount = _parse_amount(m.group("amount"))
            if amount is None:
                errors.append(ParseError(
                    page_idx, line, f"bad amount: {m.group('amount')!r}",
                ))
                continue
            t, d = _build_transaction(
                date_ts, m.group("desc"), amount, m.group("dir"),
                page_idx, line, source_file, date_inherited=False,
            )
            txns.append(t)
            debug.append(d)
            last_date = date_ts
            continue

        # Fall through to undated pattern (fees / taxes attached to the
        # previous dated row).
        m = _UNDATED_ROW_RE.match(line)
        if m:
            inherit_from = last_date or statement_date
            if inherit_from is None:
                errors.append(ParseError(
                    page_idx, line,
                    "undated row with no preceding date and no statement date",
                ))
                continue
            amount = _parse_amount(m.group("amount"))
            if amount is None:
                errors.append(ParseError(
                    page_idx, line, f"bad amount: {m.group('amount')!r}",
                ))
                continue
            t, d = _build_transaction(
                inherit_from, m.group("desc"), amount, m.group("dir"),
                page_idx, line, source_file, date_inherited=True,
            )
            txns.append(t)
            debug.append(d)
            continue

        # Anything else inside the window is unexpected noise — record
        # it as a debug entry so the user can see what we skipped.
        debug.append(DebugRow(
            page=page_idx,
            raw=line,
            tokens=[line],
            decision="sbi-cc: line did not match dated/undated row pattern",
        ))

    if not in_section:
        # We never saw the START marker. Caller's caller will decide
        # whether to warn — page 1 should always have it.
        pass

    return txns, errors, debug


# ---------------------------------------------------------------------------
# Public parser
# ---------------------------------------------------------------------------


class SBICCParser(BaseParser):
    """Parse an SBI Credit Card monthly statement PDF."""

    BANK_NAME = "SBI-CC"

    def parse_pdf(self) -> ParseResult:
        result = ParseResult(source_file=self.source_file)

        try:
            pdf = pdfplumber.open(self.file_path, password=self.password or "")
        except Exception as exc:  # noqa: BLE001
            msg = str(exc).lower()
            if "password" in msg or "decrypt" in msg or "encrypted" in msg:
                raise PermissionError(
                    "SBI CC PDF is password-protected. Provide the password and retry."
                ) from exc
            raise

        section_seen = False
        try:
            for page_idx, page in enumerate(pdf.pages, start=1):
                try:
                    raw = page.extract_text() or ""
                except Exception as exc:  # noqa: BLE001
                    logger.warning("SBI-CC: extract_text failed on page %d: %s",
                                   page_idx, exc)
                    continue
                lines = _split_clean_lines(raw)
                if not lines:
                    result.pages_parsed += 1
                    continue

                # Statement date is extracted from page 1 only — and
                # cached for use by undated rows on any subsequent page.
                if page_idx == 1:
                    self._statement_date = _extract_statement_date(lines)

                txns, errors, debug = _walk_lines(
                    lines,
                    getattr(self, "_statement_date", None),
                    self.source_file,
                    page_idx,
                )
                if txns:
                    section_seen = True
                result.transactions.extend(txns)
                result.errors.extend(errors)
                result.debug.extend(debug)
                result.pages_parsed += 1
        finally:
            pdf.close()

        if not section_seen:
            result.warnings.append(
                "No transaction section was found in the PDF. The file "
                "may be a non-standard SBI CC layout or scanned (image-only)."
            )

        # Chronological order (stable, preserves PDF order on ties).
        result.transactions.sort(key=lambda t: t.date)
        return result
