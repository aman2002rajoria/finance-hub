"""Canara Bank — savings account PDF parser.

Why a separate, text-based parser?
----------------------------------
Canara's statement PDF prints transactions inside a 5-column table
(``Date | Particulars | Deposits | Withdrawals | Balance``) but the
cell borders are not extractable by ``pdfplumber.extract_tables()`` —
that method only returns the printed header row, not the data rows.
Positional analysis with ``extract_words()`` is also fragile because
the ``Particulars`` column wraps across **3–5 physical lines** per
transaction and the date / amount / balance appear only ONCE per
transaction, in a row that visually aligns with the *middle* of the
wrapping description::

    UPI/CR/123456789012/ROHAN          <- particulars wrap line 1
    MEHTA/SBIN/**ROHAN@OKSBI/UPI//      <- particulars wrap line 2
    SBI333F5E9FE99B4F128377AF         <- particulars wrap line 3
    18-06-2025 D123456789/18/06/2025 10,000.00 1,20,000.00   <- DATE-ANCHOR
    17:51:51                          <- particulars continuation
    Chq: 123456789012                 <- TERMINATOR (always present)

Two robust signals fall out of that structure and drive this parser:

* **Boundary** — every Canara transaction ends with a literal ``Chq:``
  line (with a reference, ``Chq: 0`` for NEFT, or empty ``Chq:`` for
  interest). We accumulate non-noise lines into a buffer and finalise
  on every ``Chq:`` line.
* **Anchor** — within each buffer there is exactly one line that
  starts with ``DD-MM-YYYY`` and ends with at least two decimal
  amounts; those amounts are unambiguously the transaction amount and
  the running balance.

Credit vs debit is then determined arithmetically from the
**balance delta** (seeded by the ``Opening Balance`` line on page 1),
with a description-keyword fallback for the rare row where the delta
math is ambiguous.
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
from utils.regex_utils import (
    CANARA_DATE_REGEX,
    IFSC_REGEX,
    INR_AMOUNT_REGEX,
    PHONE_REGEX,
    canara_date_to_iso,
    find_inr_amounts,
)
from utils.text_cleaner import is_canara_noise, split_clean_lines


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Tolerance for balance-delta arithmetic. Canara prints amounts with 2
# decimal places, so 0.01 is the natural epsilon.
_BAL_TOLERANCE = 0.01

# Lines that mark the end of the transaction stream. Any line that
# matches one of these triggers a hard stop — anything after is
# disclaimer / boilerplate.
_END_OF_DATA_PATTERNS = (
    re.compile(r"^\s*closing\s+balance\b", re.IGNORECASE),
    re.compile(r"^-+\s*end\s+of\s+statement\s*-+\s*$", re.IGNORECASE),
)

# The Opening Balance line is the parser's seed for the
# balance-delta classifier.
_OPENING_BALANCE_RE = re.compile(
    r"^\s*opening\s+balance\b\s*(.+)$", re.IGNORECASE
)

# Lines that terminate a transaction buffer. ``Chq:`` is *always* the
# last line of a Canara transaction (per our analysis of the real PDF).
_CHQ_LINE_RE = re.compile(r"^\s*chq\s*:\s*(.*)$", re.IGNORECASE)

# Reference extraction regexes (used when the Chq: value is missing /
# zero, e.g. for NEFT and SBINT transactions).
_UPI_REF_RE = re.compile(r"\bUPI/(?:CR|DR)/(\d{6,})/", re.IGNORECASE)
_NEFT_UTR_RE = re.compile(r"\bNEFT\s+(?:CR|DR)\s*[-/]\s*([A-Z0-9]{10,})", re.IGNORECASE)

# Categorisation table. Order matters — first match wins.
_CATEGORY_PATTERNS: List[Tuple[str, re.Pattern[str]]] = [
    ("Interest", re.compile(r"^\s*SBINT\b|\binterest\b", re.IGNORECASE)),
    ("NEFT",     re.compile(r"\bNEFT\b", re.IGNORECASE)),
    ("IMPS",     re.compile(r"\bIMPS\b", re.IGNORECASE)),
    ("RTGS",     re.compile(r"\bRTGS\b", re.IGNORECASE)),
    ("ATM",      re.compile(r"\bATM\b", re.IGNORECASE)),
    ("UPI",      re.compile(r"\bUPI/", re.IGNORECASE)),
    ("Cash",     re.compile(r"\bcash\b", re.IGNORECASE)),
]

# Description keywords used as a fallback when balance-delta cannot
# disambiguate (e.g. the very first transaction with no seed, or an
# anchor with off-by-paise rounding from the PDF).
_DEBIT_KEYWORDS = (
    "upi/dr/", "neft dr-", "imps dr-", "rtgs dr-", "atm wdl",
    "withdrawal", "payment to",
)
_CREDIT_KEYWORDS = (
    "upi/cr/", "neft cr-", "imps cr-", "rtgs cr-", "sbint",
    "interest", "deposit", "credit", "refund",
)


# ---------------------------------------------------------------------------
# Buffer / block builder
# ---------------------------------------------------------------------------


def _accumulate_blocks(
    lines: List[str],
) -> Tuple[List[List[str]], Optional[float], List[str]]:
    """Walk all lines (already noise-filtered above) and group them by ``Chq:``.

    Returns:
        blocks: list of transaction blocks (each is a list of lines, the
            last of which is the ``Chq:`` terminator).
        opening_balance: the ``Opening Balance`` value, if found.
        skipped_pre_opening: lines that appeared *before* the Opening
            Balance marker (page-1 customer/address block). Returned
            only so the caller can record them in the debug log.
    """
    blocks: List[List[str]] = []
    buffer: List[str] = []
    opening_balance: Optional[float] = None
    skipped_pre_opening: List[str] = []
    seen_opening = False
    stopped = False

    for raw in lines:
        if stopped:
            break

        line = raw.strip()
        if not line:
            continue

        # Hard stop on closing balance / end-of-statement.
        for pat in _END_OF_DATA_PATTERNS:
            if pat.match(line):
                stopped = True
                break
        if stopped:
            break

        # Seed the opening balance, then start collecting transactions
        # from the very next non-noise line.
        if not seen_opening:
            ob = _OPENING_BALANCE_RE.match(line)
            if ob:
                amts = find_inr_amounts(ob.group(1))
                if amts:
                    opening_balance = amts[-1][2]
                seen_opening = True
                continue
            else:
                # Anything before Opening Balance is the page-1
                # customer / address block — drop it.
                skipped_pre_opening.append(line)
                continue

        if is_canara_noise(line):
            # Drop repeated column headers and page footers without
            # disturbing the in-progress buffer.
            continue

        buffer.append(line)

        # ``Chq:`` always terminates a Canara transaction.
        if _CHQ_LINE_RE.match(line):
            if buffer:
                blocks.append(buffer)
            buffer = []

    # A buffer left dangling after the loop means the final transaction
    # didn't have its Chq: terminator (very unlikely on a well-formed
    # statement, but handle it defensively rather than losing the row).
    if buffer:
        blocks.append(buffer)

    return blocks, opening_balance, skipped_pre_opening


# ---------------------------------------------------------------------------
# Block parser
# ---------------------------------------------------------------------------


def _find_anchor_idx(block: List[str]) -> int:
    """Return the index of the date-anchor line within ``block``.

    The anchor is the unique line that (a) starts with ``DD-MM-YYYY``
    and (b) contains at least one decimal amount. We require BOTH
    conditions because some Canara transactions have stray date-like
    substrings in the description (e.g. ``D123456789/18/06/2025`` is
    embedded in a UPI ref) that happen to start with digits but never
    at the very start of their physical line.
    """
    for i, ln in enumerate(block):
        if not CANARA_DATE_REGEX.match(ln):
            continue
        if find_inr_amounts(ln):
            return i
    return -1


def _extract_chq_ref(block: List[str]) -> str:
    """Return the bare reference from the block's ``Chq:`` line (empty if none)."""
    for ln in reversed(block):
        m = _CHQ_LINE_RE.match(ln)
        if m:
            return m.group(1).strip()
    return ""


def _categorise(desc: str) -> Optional[str]:
    """Map a description to a coarse category for ``txn_mode``."""
    for label, pattern in _CATEGORY_PATTERNS:
        if pattern.search(desc):
            return label
    return None


def _hash_reference(date_iso: str, description: str, amount: float) -> str:
    """Stable synthetic reference for transactions with no Chq / UPI ref.

    Used as a last-resort identifier so downstream dedupe keys remain
    unique. We use a short SHA-1 prefix (10 hex chars = 40 bits) which
    is collision-safe at the scale of a personal statement.
    """
    seed = f"{date_iso}|{description}|{amount:.2f}"
    return "HASH-" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:10].upper()


def _extract_reference(block: List[str], description: str,
                       date_iso: str, amount: float) -> str:
    """Resolve a meaningful reference for the transaction.

    Priority:
        1. ``Chq: <value>`` when it has a non-zero value.
        2. The 12-digit UPI ref embedded in the description.
        3. The NEFT UTR (``NESFN...`` / ``HDFCH...``) in the description.
        4. A stable hash of the (date, description, amount) tuple.
    """
    chq = _extract_chq_ref(block)
    if chq and chq != "0":
        return chq

    upi = _UPI_REF_RE.search(description)
    if upi:
        return upi.group(1)

    neft = _NEFT_UTR_RE.search(description)
    if neft:
        return neft.group(1)

    return _hash_reference(date_iso, description, amount)


def _classify_direction(
    amount: float,
    balance: float,
    prev_balance: Optional[float],
    description: str,
) -> str:
    """Return ``"credit"`` or ``"debit"`` for this transaction.

    The primary signal is balance-delta arithmetic — if
    ``balance - prev_balance == +amount`` it must be a credit, if
    ``== -amount`` it must be a debit. This is bulletproof for Canara
    because every row has a balance and we seed from the printed
    Opening Balance. We fall back to description keywords only when
    delta math is unavailable (first transaction) or ambiguous.
    """
    if prev_balance is not None:
        delta = balance - prev_balance
        if abs(delta - amount) <= _BAL_TOLERANCE:
            return "credit"
        if abs(delta + amount) <= _BAL_TOLERANCE:
            return "debit"

    desc_lower = description.lower()
    if any(k in desc_lower for k in _DEBIT_KEYWORDS):
        return "debit"
    if any(k in desc_lower for k in _CREDIT_KEYWORDS):
        return "credit"
    # Last resort: default to debit (every personal statement has more
    # debits than credits; this only ever fires for true edge cases).
    return "debit"


def _build_description(block: List[str], anchor_idx: int, anchor_text: str) -> str:
    """Join every block line into one cleaned description string.

    The anchor line keeps only the *description fragment* between the
    date and the trailing two amounts. The ``Chq:`` terminator is
    dropped (its value is captured separately as the reference).
    """
    parts: List[str] = []
    for i, ln in enumerate(block):
        if _CHQ_LINE_RE.match(ln):
            continue
        if i == anchor_idx:
            parts.append(anchor_text)
        else:
            parts.append(ln)

    joined = " ".join(p for p in parts if p)
    joined = re.sub(r"\s+", " ", joined).strip()
    return joined.strip(" -|\t")


def _parse_block(
    block: List[str],
    prev_balance: Optional[float],
    source_file: str,
) -> Tuple[Optional[Transaction], Optional[ParseError], Optional[DebugRow]]:
    """Convert one ``Chq:``-terminated block into a :class:`Transaction`."""
    if not block:
        return None, None, None

    anchor_idx = _find_anchor_idx(block)
    if anchor_idx < 0:
        # No date+amount anchor — almost certainly a noise block that
        # leaked through. Record it as an error so the user can see it
        # in the debug log without crashing the parser.
        raw = " | ".join(block)
        return (
            None,
            ParseError(0, raw, "no date-anchor line found in block"),
            DebugRow(0, raw, block, "canara: no anchor"),
        )

    anchor_line = block[anchor_idx]
    dm = CANARA_DATE_REGEX.match(anchor_line)
    iso = canara_date_to_iso(dm.group(1), dm.group(2), dm.group(3))
    if iso is None:
        raw = " | ".join(block)
        return (
            None,
            ParseError(0, raw, f"bad date in anchor: {dm.group(0)!r}"),
            DebugRow(0, raw, block, "canara: bad date"),
        )
    date_ts = pd.Timestamp(iso)

    # Trailing two amounts on the anchor = (amount, balance).
    rest = anchor_line[dm.end():]
    amounts = find_inr_amounts(rest)
    if len(amounts) < 2:
        raw = " | ".join(block)
        return (
            None,
            ParseError(
                0, raw,
                f"anchor has {len(amounts)} amounts, expected >= 2",
            ),
            DebugRow(0, raw, block, "canara: <2 amounts"),
        )

    amt_start, amt_end, amount = amounts[-2]
    bal_start, bal_end, balance = amounts[-1]

    # Description fragment on the anchor line = text between the date
    # and the transaction amount.
    anchor_desc = rest[:amt_start].strip()
    description = _build_description(block, anchor_idx, f"{anchor_desc}".strip())

    # Reference + direction.
    reference = _extract_reference(block, description, iso, amount)
    direction = _classify_direction(amount, balance, prev_balance, description)

    debit_val = float(amount) if direction == "debit" else 0.0
    credit_val = 0.0 if direction == "debit" else float(amount)

    # Structured fields (best-effort, mirrors the Slice/SBI schema).
    vpa_match = re.search(r"\*\*[A-Za-z0-9._\-]+@[A-Za-z0-9._\-]+", description)
    ifsc_match = IFSC_REGEX.search(description)
    phone_match = PHONE_REGEX.search(description)

    txn = Transaction(
        date=date_ts,
        description=description,
        debit=debit_val,
        credit=credit_val,
        balance=float(balance),
        source="Canara",
        source_file=source_file,
        txn_mode=_categorise(description),
        txn_reference=reference,
        txn_vpa=vpa_match.group(0) if vpa_match else None,
        txn_counterparty=_extract_counterparty(description),
        txn_bank=ifsc_match.group(1)[:4] if ifsc_match else None,
        txn_phone=phone_match.group(1) if phone_match else None,
        txn_raw_description=description,
    )

    decision = (
        f"canara-text: anchor#{anchor_idx} amt={amount} bal={balance} "
        f"prev={prev_balance} ref={reference} -> {direction.upper()}"
    )
    raw = " | ".join(block)
    dbg = DebugRow(
        page=0,  # page index is filled in by the caller
        raw=raw,
        tokens=block,
        decision=decision,
        date=dm.group(0),
        debit=debit_val,
        credit=credit_val,
        balance=float(balance),
    )
    return txn, None, dbg


def _extract_counterparty(desc: str) -> Optional[str]:
    """Best-effort counterparty extraction from a Canara description.

    UPI strings look like ``UPI/CR/123456789012/ROHAN MEHTA/SBIN/...`` so
    the counterparty is the 4th ``/``-delimited segment. NEFT strings
    look like ``NEFT CR-NESFN25000000001-NESF0000001-NORTH EAST SMALL
    FINANCE BANK-`` so the counterparty is the segment after the 3rd
    ``-``. We try both and return the first that yields a non-empty,
    non-numeric value.
    """
    upi = re.search(r"\bUPI/(?:CR|DR)/\d+/([A-Z][A-Z .]*?)/[A-Z]{4}\b",
                    desc, re.IGNORECASE)
    if upi:
        name = upi.group(1).strip(" .")
        if name:
            return name

    neft = re.search(
        r"\bNEFT\s+(?:CR|DR)\s*-\s*[A-Z0-9]+\s*-\s*[A-Z0-9]+\s*-\s*([^-\n]+?)\s*-",
        desc, re.IGNORECASE,
    )
    if neft:
        return neft.group(1).strip()

    return None


# ---------------------------------------------------------------------------
# Public parser
# ---------------------------------------------------------------------------


class CanaraParser(BaseParser):
    """Parse a digital Canara Bank savings-account PDF statement."""

    BANK_NAME = "Canara"

    def parse_pdf(self) -> ParseResult:
        result = ParseResult(source_file=self.source_file)

        try:
            pdf = pdfplumber.open(self.file_path, password=self.password or "")
        except Exception as exc:  # noqa: BLE001
            msg = str(exc).lower()
            if "password" in msg or "decrypt" in msg or "encrypted" in msg:
                raise PermissionError(
                    "Canara PDF is password-protected. Provide the password and retry."
                ) from exc
            raise

        try:
            # Collect every line from every page, tagged with its page
            # index so debug rows are still page-aware. We then run ONE
            # buffer-by-Chq pass across the whole stream so transactions
            # that span page boundaries are joined correctly.
            tagged_lines: List[Tuple[int, str]] = []
            for page_idx, page in enumerate(pdf.pages, start=1):
                try:
                    txt = page.extract_text() or ""
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Canara: extract_text failed on page %d: %s",
                                   page_idx, exc)
                    continue
                for ln in split_clean_lines(txt):
                    tagged_lines.append((page_idx, ln))
                result.pages_parsed += 1
        finally:
            pdf.close()

        if not tagged_lines:
            result.warnings.append(
                "No text extracted from the PDF. The file may be scanned (image-only)."
            )
            return result

        # Strip the page index and run the block accumulator.
        flat_lines = [ln for _, ln in tagged_lines]
        blocks, opening_balance, skipped = _accumulate_blocks(flat_lines)
        if opening_balance is None:
            result.warnings.append(
                "Could not find an 'Opening Balance' row — credit/debit "
                "classification for the first transaction will fall back "
                "to description keywords."
            )

        # Build a fast (line-text -> page) lookup so we can stamp each
        # block with the page its anchor came from. Multiple identical
        # lines map to the FIRST occurrence; close enough for debug
        # display (the anchor line is unique per transaction anyway).
        line_to_page = {}
        for pg, ln in tagged_lines:
            line_to_page.setdefault(ln, pg)

        prev_balance: Optional[float] = opening_balance
        for block in blocks:
            t, e, d = _parse_block(block, prev_balance, self.source_file)
            anchor_page = 0
            for ln in block:
                if ln in line_to_page:
                    anchor_page = line_to_page[ln]
                    break
            if t is not None:
                result.transactions.append(t)
                prev_balance = t.balance
            if e is not None:
                e.page = anchor_page
                result.errors.append(e)
            if d is not None:
                d.page = anchor_page
                result.debug.append(d)

        if not result.transactions:
            result.warnings.append(
                "No transactions extracted. The PDF may be a non-standard "
                "Canara layout — please report the file for parser tuning."
            )

        # Stable chronological order so the output is identical to the
        # printed statement order. We sort by date ONLY (not (date,
        # balance)) so Python's stable sort preserves the PDF's
        # within-day order — which is the true chronological order
        # since Canara prints transactions in posting order.
        result.transactions.sort(key=lambda t: t.date)
        return result
