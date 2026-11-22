"""Slice Small Finance Bank — savings account PDF parser.

Why a separate, text-based parser?
----------------------------------
The SBI parser is *positional* (it reads the printed column x-coordinates
because SBI statements have noisy column boundaries that bleed into each
other when extracted as plain text). Slice's statements are the opposite:
each transaction prints on a single line in a very strict and
human-readable layout::

    DATE                DETAILS                              REF NO.          AMOUNT     BALANCE
    01 Aug '25          Interest Cr. for 31-Jul-2025         20000000000001   ₹0.08      ₹500.00
    20 Aug '25          UPI Debit-Ravi Kumar-..@slc-1234567 800000000000001  -₹210      ₹290.00
                        37232-Payment from slice

For this format, ``page.extract_text()`` + line-walking is dramatically
simpler than coordinate analysis and produces zero merging artefacts.
Long descriptions wrap onto the NEXT physical line *after* the amount and
balance (i.e. the date/ref/amount/balance live on one line and only the
description spills over), so we only need:

1. line-by-line iteration,
2. a "starts with a Slice-format date" check to find transaction boundaries,
3. a right-anchored amount / balance extractor on the date line,
4. multi-line description merging across continuation lines.

The Slice parser is fully independent of the SBI parser — no shared
parsing functions, no shared regex tweaks — so changes here cannot
regress SBI output. The only shared surface is the :class:`Transaction`
dataclass and the :class:`ParseResult` driver, both defined in
:mod:`parser.base_parser`.
"""

from __future__ import annotations

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
from utils.regex_utils import (
    IFSC_REGEX,
    PHONE_REGEX,
    REFERENCE_NUM_REGEX,
    SLICE_DATE_REGEX,
    VPA_REGEX,
    find_rupee_amounts,
    line_starts_with_slice_date,
    slice_date_to_iso,
)
from utils.text_cleaner import is_slice_noise, split_clean_lines


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Phrases that, when present in a description, *force* the type to debit
# regardless of the amount sign. Slice usually marks debits with a leading
# "-₹", but a defensive double-check keeps us safe when a future statement
# variant prints the minus elsewhere (e.g. in a separate column).
DEBIT_KEYWORDS = (
    "debit",
    "payment to",
    "withdrawal",
    "atm wdl",
    "purchase",
)

# Phrases that *force* the type to credit. Listed for symmetry; in practice
# we treat any non-negative amount as credit by default.
CREDIT_KEYWORDS = (
    "interest cr",
    "interest credit",
    "credit",
    "cashback",
    "refund",
    "add funds",
    "cr.",
)

# Description-level category mapping (used to populate ``txn_mode`` so
# downstream analytics can group rows). Order matters — the first match
# wins. Patterns are matched case-insensitively against the full
# description.
CATEGORY_PATTERNS: List[Tuple[str, re.Pattern[str]]] = [
    ("Interest",  re.compile(r"\binterest\s+(cr|credit)\b", re.IGNORECASE)),
    ("UPI",       re.compile(r"\bupi\b", re.IGNORECASE)),
    ("Cashback",  re.compile(r"\bcashback\b", re.IGNORECASE)),
    ("Refund",    re.compile(r"\brefund\b", re.IGNORECASE)),
    ("AddFunds",  re.compile(r"\badd\s+funds?\b", re.IGNORECASE)),
    ("Transfer",  re.compile(r"\b(monies\s+transfer|trf|imps|neft|rtgs|casa)\b", re.IGNORECASE)),
    ("Payment",   re.compile(r"\bpayment\b", re.IGNORECASE)),
]


# ---------------------------------------------------------------------------
# Block builder  (multi-line transaction grouping)
# ---------------------------------------------------------------------------


def _group_into_blocks(lines: List[str]) -> List[List[str]]:
    """Group raw text lines into transaction blocks.

    A block starts at every line whose first token is a Slice-format date
    (``DD Mon 'YY``) and absorbs every subsequent non-noise, non-date line
    until the next date line. Noise lines (page header, footer, customer
    metadata, column header) are dropped *before* grouping so they cannot
    contaminate either the current block or the boundary detector.
    """
    blocks: List[List[str]] = []
    current: Optional[List[str]] = None

    for raw_line in lines:
        # Drop boilerplate first.
        if is_slice_noise(raw_line):
            if current is not None:
                blocks.append(current)
                current = None
            continue

        if line_starts_with_slice_date(raw_line):
            # New transaction starts -> finalise the previous one.
            if current is not None:
                blocks.append(current)
            current = [raw_line]
        else:
            # Continuation of the in-progress block (multi-line description).
            # If we have not seen a date yet at all (e.g. preamble lines on
            # page 1), skip silently.
            if current is not None:
                current.append(raw_line)

    if current is not None:
        blocks.append(current)
    return blocks


# ---------------------------------------------------------------------------
# Description structurer
# ---------------------------------------------------------------------------


def _categorise(desc: str) -> Optional[str]:
    """Map a description to a coarse category (Interest / UPI / Cashback / ...)."""
    if not desc:
        return None
    for label, pattern in CATEGORY_PATTERNS:
        if pattern.search(desc):
            return label
    return None


def _extract_counterparty(desc: str) -> Optional[str]:
    """Best-effort person/merchant name from a Slice UPI description.

    Slice UPI lines look like::

        UPI Credit-Priya .-priya.s@slc-SBIN0000001-...
        UPI Debit-Ravi Kumar-9000000000@slc-1234567...

    The counterparty is the first segment after ``UPI Credit-`` / ``UPI
    Debit-`` and before the next ``-``. We strip trailing periods/spaces
    so "Priya ." → "Priya".
    """
    m = re.search(r"\bUPI\s+(?:Credit|Debit)\s*-\s*([^-\n]+?)\s*-",
                  desc, re.IGNORECASE)
    if not m:
        return None
    name = m.group(1).strip(" .\t-")
    return name or None


def _structured_fields(desc: str) -> dict:
    """Decompose a Slice description into the same schema as SBI.

    Populates the ``txn_mode`` / ``txn_vpa`` / ``txn_counterparty`` /
    ``txn_bank`` / ``txn_phone`` / ``txn_raw_description`` columns.
    ``txn_reference`` is filled by the caller (extracted from the
    structured part of the line, not the description) — we leave it None
    here.
    """
    out = {
        "txn_mode": _categorise(desc),
        "txn_reference": None,
        "txn_vpa": None,
        "txn_counterparty": _extract_counterparty(desc),
        "txn_bank": None,
        "txn_phone": None,
        "txn_raw_description": desc,
    }

    vpa = VPA_REGEX.search(desc)
    if vpa:
        out["txn_vpa"] = vpa.group(0)

    ifsc = IFSC_REGEX.search(desc)
    if ifsc:
        out["txn_bank"] = ifsc.group(1)[:4]

    phone = PHONE_REGEX.search(desc)
    if phone:
        out["txn_phone"] = phone.group(1)

    return out


# ---------------------------------------------------------------------------
# Block parser  (one block -> one Transaction)
# ---------------------------------------------------------------------------


def _parse_block(
    block: List[str],
    page_idx: int,
    source_file: str,
) -> Tuple[Optional[Transaction], Optional[ParseError], Optional[DebugRow]]:
    """Convert one block of lines into a :class:`Transaction`.

    The first line is always the date-line that carries
    ``DATE DETAILS REF AMOUNT BALANCE``; subsequent lines are description
    continuation. The function never raises — it returns an error record
    instead so the caller's loop stays simple.
    """
    if not block:
        return None, None, None

    date_line = block[0]
    continuation = " ".join(block[1:]).strip() if len(block) > 1 else ""

    # ---- 1. Date ----
    dm = SLICE_DATE_REGEX.match(date_line)
    if not dm:
        # Shouldn't happen — _group_into_blocks guarantees this — but
        # keep a defensive path so a future caller can't crash us.
        return (
            None,
            ParseError(page_idx, date_line, "block does not start with a Slice date"),
            None,
        )
    iso = slice_date_to_iso(dm.group(1), dm.group(2), dm.group(3))
    if iso is None:
        return (
            None,
            ParseError(page_idx, date_line, f"bad date: {dm.group(0)!r}"),
            None,
        )
    date_ts = pd.Timestamp(iso)

    # ---- 2. Amounts ----
    rest = date_line[dm.end():].strip()
    amounts = find_rupee_amounts(rest)
    if len(amounts) < 2:
        return (
            None,
            ParseError(
                page_idx, date_line,
                f"expected at least 2 ₹-amounts (amount + balance), found {len(amounts)}",
            ),
            None,
        )

    # The last ₹ on the date-line is always the running balance.
    # The second-to-last is the transaction amount. The Slice template
    # never prints more than two ₹ values on the same line, so this is
    # exact; we still pick "last" / "second-to-last" defensively in case
    # a future variant adds a third (e.g. fees column).
    bal_start, bal_end, balance, _bal_neg = amounts[-1]
    amt_start, amt_end, amount, amt_negative = amounts[-2]

    # ---- 3. Reference ----
    # The reference is the last 10+ digit run *before* the amount.
    pre_amount_text = rest[:amt_start].rstrip()
    ref_matches = list(REFERENCE_NUM_REGEX.finditer(pre_amount_text))
    reference: Optional[str] = ref_matches[-1].group(0) if ref_matches else None

    # ---- 4. Description ----
    # Everything between the date end and the reference (or amount if no
    # reference was found), plus any continuation lines.
    if reference:
        cut = ref_matches[-1].start()
        desc_head = pre_amount_text[:cut].rstrip()
    else:
        desc_head = pre_amount_text
    description = re.sub(r"\s+", " ", f"{desc_head} {continuation}").strip()
    description = description.strip(" -|\t")
    if not description:
        # Should never happen on a real Slice statement, but guarantee a
        # non-empty value so downstream code never sees a bare row.
        description = f"Slice transaction {date_ts.date().isoformat()}"

    # ---- 5. Type (debit vs credit) ----
    desc_lower = description.lower()
    if amt_negative:
        is_debit = True
    elif any(k in desc_lower for k in DEBIT_KEYWORDS):
        is_debit = True
    elif any(k in desc_lower for k in CREDIT_KEYWORDS):
        is_debit = False
    else:
        # Default to credit (Slice statements show debits with a sign,
        # so an unsigned amount is overwhelmingly likely to be a credit
        # — interest, cashback, add funds, UPI credit etc).
        is_debit = False

    debit_val = float(amount) if is_debit else 0.0
    credit_val = 0.0 if is_debit else float(amount)

    # ---- 6. Structured decomposition ----
    struct = _structured_fields(description)
    struct["txn_reference"] = reference  # set by us, not the description parser

    raw_text = " | ".join(block)
    txn = Transaction(
        date=date_ts,
        description=description,
        debit=debit_val,
        credit=credit_val,
        balance=float(balance),
        source="Slice",
        source_file=source_file,
        txn_mode=struct["txn_mode"],
        txn_reference=struct["txn_reference"],
        txn_vpa=struct["txn_vpa"],
        txn_counterparty=struct["txn_counterparty"],
        txn_bank=struct["txn_bank"],
        txn_phone=struct["txn_phone"],
        txn_raw_description=struct["txn_raw_description"],
    )

    decision = (
        f"slice-text: amt={amount}{' (neg)' if amt_negative else ''} "
        f"bal={balance} ref={reference or '-'} "
        f"-> {'DR' if is_debit else 'CR'}"
    )
    dbg = DebugRow(
        page=page_idx,
        raw=raw_text,
        tokens=block,
        decision=decision,
        date=dm.group(0),
        debit=debit_val,
        credit=credit_val,
        balance=float(balance),
    )
    return txn, None, dbg


# ---------------------------------------------------------------------------
# Public parser
# ---------------------------------------------------------------------------


class SliceParser(BaseParser):
    """Parse a digital Slice savings-account PDF statement."""

    BANK_NAME = "Slice"

    # ------------------------------------------------------------------
    # Driver
    # ------------------------------------------------------------------

    def parse_pdf(self) -> ParseResult:
        result = ParseResult(source_file=self.source_file)

        try:
            pdf = pdfplumber.open(self.file_path, password=self.password or "")
        except Exception as exc:  # noqa: BLE001
            # Slice statements are rarely password-protected, but be
            # consistent with SBI's error contract.
            msg = str(exc).lower()
            if "password" in msg or "decrypt" in msg or "encrypted" in msg:
                raise PermissionError(
                    "Slice PDF is password-protected. Provide the password and retry."
                ) from exc
            raise

        try:
            for page_idx, page in enumerate(pdf.pages, start=1):
                txns, errors, debug = self._parse_page(page, page_idx)
                result.transactions.extend(txns)
                result.errors.extend(errors)
                result.debug.extend(debug)
                result.pages_parsed += 1
        finally:
            pdf.close()

        if not result.transactions:
            result.warnings.append(
                "No transactions extracted from this PDF. The file may be "
                "scanned (image-only) or in an unrecognised Slice layout."
            )

        # Sort ascending by date, then by balance order on ties (Slice
        # prints transactions in chronological order so this is stable).
        result.transactions.sort(key=lambda t: (t.date, t.balance))
        return result

    # ------------------------------------------------------------------
    # Page parser
    # ------------------------------------------------------------------

    def _parse_page(
        self,
        page,
        page_idx: int,
    ) -> Tuple[List[Transaction], List[ParseError], List[DebugRow]]:
        """Extract transactions from a single page of the Slice PDF."""
        try:
            raw_text = page.extract_text() or ""
        except Exception as exc:  # noqa: BLE001
            logger.warning("Slice: extract_text failed on page %d: %s", page_idx, exc)
            return [], [], []

        if not raw_text.strip():
            return [], [], []

        lines = split_clean_lines(raw_text)
        if not lines:
            return [], [], []

        blocks = _group_into_blocks(lines)

        txns: List[Transaction] = []
        errors: List[ParseError] = []
        debug: List[DebugRow] = []

        for block in blocks:
            t, e, d = _parse_block(block, page_idx, self.source_file)
            if t is not None:
                txns.append(t)
            if e is not None:
                errors.append(e)
            if d is not None:
                debug.append(d)

        return txns, errors, debug
