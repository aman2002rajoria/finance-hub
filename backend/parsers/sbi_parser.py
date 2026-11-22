"""SBI savings-account PDF statement parser (positional / word-level).

This parser is **rewritten** to use ``pdfplumber.Page.extract_words`` and
the printed column x-coordinates rather than text-level regex tricks.
It never guesses debit/credit from DR/CR keywords; the column an amount
sits in is determined by its x-position relative to the column header.

The pipeline
============

1.  ``extract_words(use_text_flow=False, …)`` produces every word on the
    page together with its bounding box (``x0``, ``x1``, ``top``,
    ``bottom``).
2.  Words are grouped into **visual lines** by ``top`` coordinate.
3.  The **header row** is detected (>=3 known column tokens) and the
    x-range of every column we care about (Date / Description /
    Reference / Debit / Credit / Balance) is recorded. The layout is
    persisted across pages, so continuation pages without a re-printed
    header still benefit from the boundaries we already learned.
4.  Visual lines are grouped into **transaction blocks**: a block opens
    on the first line whose leading token matches ``DD-MM-YY`` and stays
    open until the next date-leading line.
5.  Each block is converted to a :class:`Transaction` by **positional
    column assignment**:

      * every numeric token (amount-formatted *or* pure integer) is
        mapped to its nearest column (Debit / Credit / Balance / Ref)
        using x-center distance;
      * tokens that don't sit under any monetary column form the
        description (after dropping standalone long integers, which are
        reference numbers).

6.  After all pages, a **running-balance sanity sweep** flips
    debit<->credit only when the math says we got the direction wrong
    (it never invents an amount).

Hard constraints from the spec
==============================

* No DR/CR keyword inference. (Removed entirely.)
* No row is silently dropped. Every block that can't be parsed becomes a
  :class:`parser.base_parser.ParseError` with the raw text and reason,
  and EVERY block also produces a :class:`parser.base_parser.DebugRow`
  recording the parser's per-row decision.
* Description preserves multi-line wraps; reference numbers are kept out
  of the description.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import pdfplumber

from parsers.base_parser import (
    BaseParser,
    DebugRow,
    ParseError,
    ParseResult,
    Transaction,
)
from utils.helpers import (
    HEADER_TOKENS,
    clean_description,
    correct_direction_from_balance,
    is_noise_line,
    looks_like_amount,
    looks_like_date,
    looks_like_drcr,
    looks_like_integer,
    looks_like_reference,
    normalize_date,
    parse_description_structure,
    to_float,
)


logger = logging.getLogger(__name__)


# Word-grouping tolerances.
#
# ``LINE_Y_TOLERANCE`` is the most critical parameter: it decides which words
# share the same visual row. SBI statements at 8–10 pt give row heights of
# ~11–14 PDF units. Adjacent transaction rows therefore differ by at least
# 11 units in their ``top`` coordinate. Setting tolerance to 2.0 keeps words
# that truly share a row together (within-row Y jitter is always < 2 units)
# while guaranteeing adjacent rows are never merged (their gap is 11+ units).
# The previous value of 3.0 was too loose for dense SBI statements where two
# adjacent rows can be as close as ~11 units apart: rounding/rendering drift
# could occasionally put a word from row N+1 within 3 units of row N's ref top.
LINE_Y_TOLERANCE = 2.0
WORD_X_TOLERANCE = 2.0
WORD_Y_TOLERANCE = 3.0


# How far a numeric token can sit from a column header before we refuse
# to assign it to that column (px). Tuned for ~9–11 pt SBI statements;
# at column widths of 60-90 px, 45 px is a safe upper bound.
MAX_COLUMN_DISTANCE = 45.0


# Phrases (substrings) we look for in the header row, mapped to logical
# column names. Multi-word phrases are matched against 1/2/3-word
# windows in the header line, longest first.
HEADER_PHRASES: List[Tuple[str, str]] = [
    ("transaction date", "date"),
    ("txn date", "date"),
    ("tran date", "date"),
    ("post date", "date"),
    ("value date", "value_date"),
    ("transaction details", "description"),
    ("description", "description"),
    ("particulars", "description"),
    ("narration", "description"),
    ("details", "description"),
    ("ref no./cheque no.", "ref"),
    ("ref no", "ref"),
    ("cheque", "ref"),
    ("reference", "ref"),
    ("withdrawal amount", "debit"),
    ("withdrawal amt", "debit"),
    ("withdrawal", "debit"),
    ("deposit amount", "credit"),
    ("deposit amt", "credit"),
    ("deposit", "credit"),
    ("debit", "debit"),
    ("credit", "credit"),
    ("balance", "balance"),
    ("date", "date"),  # weakest catch-all, applied last
]


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


Word = Dict[str, Any]  # pdfplumber returns dict-like word entries
Line = List[Word]


@dataclass
class ColumnLayout:
    """Detected x-ranges (x0, x1) for each printed column.

    The layout is detected once from the first page that carries the
    header and re-used for subsequent (continuation) pages. We only
    update an entry the first time it's discovered to avoid jitter when
    individual header tokens shift slightly between pages.
    """

    date: Optional[Tuple[float, float]] = None
    value_date: Optional[Tuple[float, float]] = None
    description: Optional[Tuple[float, float]] = None
    ref: Optional[Tuple[float, float]] = None
    debit: Optional[Tuple[float, float]] = None
    credit: Optional[Tuple[float, float]] = None
    balance: Optional[Tuple[float, float]] = None

    def has_money_columns(self) -> bool:
        """We need balance + (debit OR credit) to do positional assignment."""
        return self.balance is not None and (
            self.debit is not None or self.credit is not None
        )

    def center_of(self, key: str) -> Optional[float]:
        rng = getattr(self, key, None)
        if not rng:
            return None
        return (rng[0] + rng[1]) / 2.0

    def merge_from(self, other: "ColumnLayout") -> None:
        """Adopt any columns from ``other`` that we don't already have."""
        for key in ("date", "value_date", "description", "ref", "debit", "credit", "balance"):
            if getattr(self, key) is None and getattr(other, key) is not None:
                setattr(self, key, getattr(other, key))


# ---------------------------------------------------------------------------
# Helpers (pure functions; no instance state)
# ---------------------------------------------------------------------------


def _looks_like_password_error(exc: BaseException) -> bool:
    """Detect pdfminer's ``PDFPasswordIncorrect`` regardless of wrapping."""
    queue: List[BaseException] = [exc]
    seen: set[int] = set()
    while queue:
        e = queue.pop(0)
        if id(e) in seen:
            continue
        seen.add(id(e))
        name = type(e).__name__.lower()
        msg = (str(e) or "").lower()
        if "password" in name or "encrypt" in name or "password" in msg or "encrypt" in msg:
            return True
        for arg in getattr(e, "args", ()):
            if isinstance(arg, BaseException):
                queue.append(arg)
        if e.__cause__:
            queue.append(e.__cause__)
        if e.__context__:
            queue.append(e.__context__)
    return False


def _group_into_lines(words: List[Word], y_tolerance: float = LINE_Y_TOLERANCE) -> List[Line]:
    """Group word dicts into visual lines by ``top`` coordinate.

    Algorithm (sequential scan)
    ---------------------------
    Words are sorted globally by (top, x0). We walk through them linearly,
    accumulating a ``current_line``. A word is added to the current line
    when its ``top`` is within ``y_tolerance`` of the *first word's* ``top``
    in that line. Otherwise it closes the current line and starts a new one.

    Why sequential, not "search all existing lines":
    The previous approach checked each word against every existing line's
    reference ``top``. This caused Y-coordinate "drift": if line 1 had its
    reference top at 100 and a word from row 2 had ``top=103`` (within
    tolerance 3), it was placed in line 1 rather than starting line 2. Two
    adjacent transaction rows would then merge into a single "line", causing
    their words to appear in one block and their descriptions to contaminate
    each other. The sequential algorithm closes line 1 as soon as a word
    falls outside tolerance, guaranteeing that each distinct Y-band becomes
    its own line.
    """
    if not words:
        return []

    # Global sort by top first; x0 as a tiebreaker so words at identical
    # tops come out left-to-right immediately (saves the per-line re-sort).
    sorted_words = sorted(words, key=lambda w: (w["top"], w["x0"]))

    lines: List[Line] = []
    current: Line = [sorted_words[0]]
    ref_top: float = sorted_words[0]["top"]

    for w in sorted_words[1:]:
        if abs(w["top"] - ref_top) <= y_tolerance:
            # Same visual row: accumulate.
            current.append(w)
        else:
            # New visual row: commit current line sorted left-to-right.
            lines.append(sorted(current, key=lambda x: x["x0"]))
            current = [w]
            ref_top = w["top"]

    if current:
        lines.append(sorted(current, key=lambda x: x["x0"]))

    return lines


def _line_text(line: Line) -> str:
    return " ".join(w["text"] for w in line)


# Dashes SBI prints in empty Debit/Credit cells.
_DASH_TOKENS: frozenset[str] = frozenset({"-", "--", "–", "—"})


def _line_is_amounts_only(line: Line) -> bool:
    """True when a continuation line contains only amount / balance tokens.

    SBI statements sometimes lay out a transaction across two visual rows:
    the description on row 1 and the debit/credit/balance values on row 2.
    Detecting this pattern lets ``_group_into_blocks`` finalise the current
    block **immediately** after the amounts arrive, rather than waiting for
    the next date-starting line.

    Benefit
    -------
    Any footer / header text that appears in the gap between the amounts
    line and the next transaction's date is then correctly ignored instead
    of being appended to the completed transaction's description.

    Criteria (all must hold)
    ------------------------
    (a) No alphabetic words are present.  A genuine amounts-only line has
        no narration; any alphabetic token means this is still description.
    (b) At least one token is a properly formatted decimal amount
        (``looks_like_amount`` — has a ``.`` or ``,``).
    (c) At least two tokens in total are numeric or dash-like
        (debit + balance minimum, or credit + balance minimum).

    Short integers (<= 6 digits) count as numeric because SBI sometimes
    prints a bare ``0`` for an absent debit or credit column.  Long
    integers (reference numbers) are intentionally excluded.
    """
    if not line:
        return False

    has_alpha = False
    decimal_count = 0
    numeric_count = 0

    for w in line:
        t = w["text"]
        if t in _DASH_TOKENS:
            numeric_count += 1          # dash = empty amount cell
        elif looks_like_amount(t):
            decimal_count += 1
            numeric_count += 1
        elif looks_like_integer(t) and len(t.replace(",", "")) <= 6:
            numeric_count += 1          # short integer (amount, not ref no.)
        elif re.search(r"[a-zA-Z]", t):
            has_alpha = True
            break                       # any letter → not amounts-only
        # Anything else (unknown punctuation etc.) is neutral — we don't
        # count it, but we don't fail either.

    return not has_alpha and decimal_count >= 1 and numeric_count >= 2


def _detect_header_layout(line: Line) -> Optional[ColumnLayout]:
    """If ``line`` is a column-header row, return the column x-ranges.

    The line is treated as a header when ``HEADER_TOKENS`` matches >=3
    of its substrings. We then walk the words, trying 3/2/1-word windows
    against ``HEADER_PHRASES`` (longest first) and recording the span of
    each matched window into the corresponding logical column.
    """
    text = _line_text(line).lower()
    hits = sum(1 for tok in HEADER_TOKENS if tok in text)
    if hits < 3:
        return None

    layout = ColumnLayout()
    used = [False] * len(line)

    def _norm(s: str) -> str:
        # Lowercase, collapse whitespace, strip ALL ``.`` / ``,`` / ``:``
        # punctuation so headers like "Ref No./Cheque No." compare equal
        # to "ref no/cheque no" (which is how pdfplumber tokenises them).
        s = re.sub(r"\s+", " ", s.lower())
        s = re.sub(r"[.,:]", "", s)
        return s.strip()

    norm_phrases = [(_norm(needle), key) for needle, key in HEADER_PHRASES]

    # For each starting position, try the LONGEST window that exactly
    # matches a header phrase. This is intentionally exact-match (not
    # substring) so that a 3-word window like "txn date value" does not
    # accidentally swallow the 2-word "txn date" phrase.
    i = 0
    while i < len(line):
        if used[i]:
            i += 1
            continue
        matched = False
        for size in (3, 2, 1):
            if i + size > len(line) or any(used[i:i + size]):
                continue
            raw = " ".join(line[i + k]["text"] for k in range(size))
            phrase_norm = _norm(raw)
            for needle, key in norm_phrases:
                if phrase_norm != needle:
                    continue
                if getattr(layout, key) is not None:
                    # Already set by an earlier (more specific) match.
                    matched = True
                    break
                x0 = line[i]["x0"]
                x1 = line[i + size - 1]["x1"]
                setattr(layout, key, (x0, x1))
                for k in range(size):
                    used[i + k] = True
                matched = True
                break
            if matched:
                break
        i += 1

    return layout if layout.has_money_columns() else None


def _assign_to_column(
    layout: ColumnLayout,
    x_center: float,
    candidates: Tuple[str, ...] = ("debit", "credit", "balance", "ref"),
    max_distance: float = MAX_COLUMN_DISTANCE,
) -> Optional[str]:
    """Return the logical column whose center is closest to ``x_center``.

    Returns ``None`` if no column is within ``max_distance``.
    """
    best_key = None
    best_dist = float("inf")
    for key in candidates:
        c = layout.center_of(key)
        if c is None:
            continue
        d = abs(x_center - c)
        if d < best_dist:
            best_dist = d
            best_key = key
    if best_key is None or best_dist > max_distance:
        return None
    return best_key


# Glued-ref stripper used as a last-resort safety net on the assembled
# description. Matches a trailing run of digits (>=10) preceded by a
# non-whitespace character — i.e. a reference number that pdfplumber
# wedged onto the end of the previous word with no space gap.
_TRAILING_GLUED_REF = re.compile(r"(?<=\S)(\d{10,16})\s*$")


def _strip_trailing_glued_ref(description: str) -> str:
    """Drop a numeric reference that got glued onto the end of a description.

    Example: ``UPI/DR/RAMESH/IPOS/rameshk123456789012`` ->
    ``UPI/DR/RAMESH/IPOS/rameshk``. We require at least 10 trailing
    digits so we don't accidentally truncate genuine amounts or short
    digits inside the description.
    """
    if not description:
        return description
    return _TRAILING_GLUED_REF.sub("", description).rstrip()


# ---------------------------------------------------------------------------
# Table-extraction helpers  (PRIMARY strategy — used by v1/v2 scripts too)
# ---------------------------------------------------------------------------

# Column name tokens we recognise in the header row.
# These cover SBI's various header phrasings across statement generations.
_TABLE_DATE_HDRS    = {"txn date", "tran date", "transaction date", "date", "post date"}
_TABLE_DESC_HDRS    = {"description", "particulars", "narration", "transaction details"}
_TABLE_REF_HDRS     = {"ref no", "ref no.", "ref no./chq.no.", "chq no", "reference", "cheque no"}
_TABLE_DEBIT_HDRS   = {"debit", "withdrawals", "dr"}
_TABLE_CREDIT_HDRS  = {"credit", "deposits", "cr"}
_TABLE_BALANCE_HDRS = {"balance", "closing balance"}

_DATE_CELL_RE = re.compile(r"^\d{2}-\d{2}-\d{2}$")


def _map_table_columns(header_row: List) -> Dict[str, int]:
    """Map logical column names → column indices from a header row.

    Returns a dict with keys: date, description, ref, debit, credit, balance.
    Missing columns are omitted from the result.
    """
    mapping: Dict[str, int] = {}
    for i, cell in enumerate(header_row):
        if cell is None:
            continue
        norm = str(cell).strip().lower()
        if norm in _TABLE_DATE_HDRS and "date" not in mapping:
            mapping["date"] = i
        elif norm in _TABLE_DESC_HDRS:
            mapping["description"] = i
        elif norm in _TABLE_REF_HDRS:
            mapping["ref"] = i
        elif norm in _TABLE_DEBIT_HDRS:
            mapping["debit"] = i
        elif norm in _TABLE_CREDIT_HDRS:
            mapping["credit"] = i
        elif norm in _TABLE_BALANCE_HDRS:
            mapping["balance"] = i
    return mapping


def _safe_cell(row: List, idx: Optional[int], default: str = "") -> str:
    """Return row[idx] as a stripped string, or default."""
    if idx is None or idx >= len(row):
        return default
    val = row[idx]
    return str(val).strip() if val is not None else default


def _parse_table_row(
    row: List,
    col_map: Dict[str, int],
    page_idx: int,
    source_file: str,
) -> Tuple[Optional[Transaction], Optional[ParseError], Optional[DebugRow]]:
    """Convert one table row (already split into cells) to a Transaction.

    If the column-header map is incomplete (e.g. pdfplumber found no header),
    we fall back to positional assumptions:
        col 0 = TxnDate, col 1 = ValDate, col 2 = Description,
        col 3 = Ref,     col 4 = Debit,   col 5 = Credit,  col 6 = Balance
    """
    # Resolve cells
    date_str  = _safe_cell(row, col_map.get("date"))
    desc_raw  = _safe_cell(row, col_map.get("description"))
    debit_s   = _safe_cell(row, col_map.get("debit"))
    credit_s  = _safe_cell(row, col_map.get("credit"))
    balance_s = _safe_cell(row, col_map.get("balance"))

    # If no column map yet, try positional defaults for 7-column SBI tables.
    if not col_map and len(row) >= 5:
        date_str  = _safe_cell(row, 0)
        desc_raw  = _safe_cell(row, 2)
        debit_s   = _safe_cell(row, 4)
        credit_s  = _safe_cell(row, 5)
        balance_s = _safe_cell(row, 6) if len(row) > 6 else _safe_cell(row, 4)

    raw = " | ".join(str(c or "").strip() for c in row)
    tokens = [str(c or "").strip() for c in row]

    if not _DATE_CELL_RE.match(date_str):
        # Not a transaction row — skip silently.
        return None, None, None

    date_value = normalize_date(date_str)
    if date_value is None:
        return (
            None,
            ParseError(page_idx, raw, f"bad date: {date_str!r}"),
            DebugRow(page_idx, raw, tokens, "table: bad date", date=date_str),
        )

    debit   = to_float(debit_s)   or 0.0
    credit  = to_float(credit_s)  or 0.0
    balance = to_float(balance_s) or 0.0

    # Dash in a money cell means zero — already handled by to_float returning None.

    description = clean_description(desc_raw) or desc_raw or raw

    if debit == 0.0 and credit == 0.0 and balance == 0.0:
        err = ParseError(page_idx, raw, "all amounts zero (table row)")
        dbg = DebugRow(page_idx, raw, tokens, "table: all-zero", date=date_str)
        return None, err, dbg

    struct = parse_description_structure(description)
    decision = f"table: D={debit} C={credit} B={balance}"

    txn = Transaction(
        date=date_value,
        description=description,
        debit=float(debit),
        credit=float(credit),
        balance=float(balance),
        source="SBI",
        source_file=source_file,
        txn_mode=struct["txn_mode"],
        txn_reference=struct["txn_reference"],
        txn_vpa=struct["txn_vpa"],
        txn_counterparty=struct["txn_counterparty"],
        txn_bank=struct["txn_bank"],
        txn_phone=struct["txn_phone"],
        txn_raw_description=struct["txn_raw_description"],
    )
    dbg = DebugRow(
        page=page_idx,
        raw=raw,
        tokens=tokens,
        decision=decision,
        date=date_str,
        debit=float(debit),
        credit=float(credit),
        balance=float(balance),
    )
    return txn, None, dbg


# ---------------------------------------------------------------------------
# Text-accumulation helpers  (fallback when tables + words both yield 0 txns)
# ---------------------------------------------------------------------------

# Matches the *tail* of an accumulated transaction string when it ends with
# the classic SBI amount pattern:  [debit_or_dash] [credit_or_0] [balance]
# Each cell may be: plain integer, decimal, Indian comma-number, or "-".
_TXN_COMPLETE_RE = re.compile(
    r"(?:[-–—]|[\d,]+(?:\.\d+)?)"   # debit column  (dash or number)
    r"\s+"
    r"(?:[\d,]+(?:\.\d+)?)"          # credit column (number)
    r"\s+"
    r"(?:[\d,]+(?:\.\d+)?)"          # balance       (number)
    r"\s*$",
)

# Up to 3 trailing numbers (balance always last, credit/debit before it).
_TRAILING_AMOUNTS_RE = re.compile(
    r"([-–—]|[\d,]+(?:\.\d+)?)"
    r"\s+([\d,]+(?:\.\d+)?)"
    r"\s+([\d,]+(?:\.\d+)?)"
    r"\s*$",
)


def _accumulate_text_transactions(raw_text: str) -> List[str]:
    """Split raw page text into individual transaction strings.

    Algorithm (per the user's specification)
    -----------------------------------------
    1. Split into lines.
    2. Skip noise lines.
    3. When a line starts with ``DD-MM-YY``, it begins a new transaction
       buffer.
    4. Non-date lines are appended to the current buffer (multi-line
       description or split amounts row).
    5. A buffer is *finalised* (committed as a complete transaction) as
       soon as its accumulated text ends with the pattern
       ``<num-or-dash>  <num>  <num>`` (debit / credit / balance).

    This naturally handles both single-line and multi-line layouts and
    ensures that footer text appearing *after* the amounts line is never
    captured (the buffer is already closed before the footer arrives).
    """
    date_re = re.compile(r"^\d{2}-\d{2}-\d{2}\b")
    transactions: List[str] = []
    buffer: List[str] = []

    def _try_commit() -> bool:
        """If the accumulated buffer ends with amounts, commit it."""
        if not buffer:
            return False
        acc = " ".join(buffer)
        if _TXN_COMPLETE_RE.search(acc):
            transactions.append(acc)
            buffer.clear()
            return True
        return False

    for raw_line in raw_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if is_noise_line(line):
            continue
        lowered = line.lower()
        if sum(1 for tok in HEADER_TOKENS if tok in lowered) >= 3:
            continue

        if date_re.match(line):
            # New transaction starts — commit the previous one first.
            _try_commit()
            if buffer:
                # Previous buffer was incomplete (no trailing amounts yet).
                # Save it as-is so we don't silently drop anything.
                transactions.append(" ".join(buffer))
                buffer.clear()
            buffer.append(line)
        else:
            if buffer:
                buffer.append(line)
                _try_commit()

    # Flush any remaining buffer.
    if buffer:
        acc = " ".join(buffer)
        transactions.append(acc)

    return transactions


def _parse_text_transaction(
    acc: str,
    page_idx: int,
    source_file: str,
) -> Tuple[Optional[Transaction], Optional[ParseError], Optional[DebugRow]]:
    """Parse one accumulated transaction string into a Transaction.

    Approach
    --------
    * Extract the date from the leading token.
    * Strip up to 3 trailing numeric/dash tokens (balance / credit|debit).
    * Everything in between is the description.
    * The balance-delta sweep in ``parse_pdf`` handles debit/credit
      direction if we can't determine it from position alone.
    """
    tokens = acc.split()
    if not tokens:
        return None, ParseError(page_idx, acc, "empty string"), None

    date_str = tokens[0]
    if not looks_like_date(date_str):
        return (
            None,
            ParseError(page_idx, acc, f"does not start with date: {date_str!r}"),
            DebugRow(page_idx, acc, tokens, "text: no leading date"),
        )

    date_value = normalize_date(date_str)
    if date_value is None:
        return (
            None,
            ParseError(page_idx, acc, f"bad date: {date_str!r}"),
            DebugRow(page_idx, acc, tokens, "text: bad date"),
        )

    # If second token is also a date it's the "value date" — skip it.
    start = 1
    if len(tokens) > 1 and looks_like_date(tokens[1]):
        start = 2

    m = _TRAILING_AMOUNTS_RE.search(acc)
    if m is None:
        # No trailing amounts — store as a parse error so we don't lose the row.
        err = ParseError(page_idx, acc, "no trailing amount pattern")
        dbg = DebugRow(page_idx, acc, tokens, "text: no amounts",
                       date=date_str)
        return None, err, dbg

    raw_debit_str, raw_credit_str, raw_balance_str = m.group(1), m.group(2), m.group(3)

    balance = to_float(raw_balance_str) or 0.0
    credit  = to_float(raw_credit_str)  or 0.0
    debit   = to_float(raw_debit_str)   or 0.0   # 0 when token is "-"

    # Description = everything between date tokens and trailing amounts.
    # Find the character position where the amounts match begins.
    amounts_start = m.start()
    prefix = acc[:amounts_start].strip()
    # Remove up to 2 leading date tokens from the prefix.
    prefix = re.sub(r"^\s*\d{2}[-/]\d{2}[-/]\d{2,4}\s+", "", prefix)
    prefix = re.sub(r"^\s*\d{2}[-/]\d{2}[-/]\d{2,4}\s+", "", prefix)
    description = clean_description(prefix) or acc

    if debit == 0.0 and credit == 0.0 and balance == 0.0:
        err = ParseError(page_idx, acc, "all amounts zero after text parse")
        dbg = DebugRow(page_idx, acc, tokens, "text: all-zero",
                       date=date_str)
        return None, err, dbg

    struct = parse_description_structure(description)
    decision = f"text-accumulation: D={debit} C={credit} B={balance}"

    txn = Transaction(
        date=date_value,
        description=description,
        debit=float(debit),
        credit=float(credit),
        balance=float(balance),
        source="SBI",
        source_file=source_file,
        txn_mode=struct["txn_mode"],
        txn_reference=struct["txn_reference"],
        txn_vpa=struct["txn_vpa"],
        txn_counterparty=struct["txn_counterparty"],
        txn_bank=struct["txn_bank"],
        txn_phone=struct["txn_phone"],
        txn_raw_description=struct["txn_raw_description"],
    )
    dbg = DebugRow(
        page=page_idx,
        raw=acc,
        tokens=tokens,
        decision=decision,
        date=date_str,
        debit=float(debit),
        credit=float(credit),
        balance=float(balance),
    )
    return txn, None, dbg


# ---------------------------------------------------------------------------
# Main parser
# ---------------------------------------------------------------------------


class SBIParser(BaseParser):
    """Word-level positional parser for SBI savings statements."""

    BANK_NAME = "SBI"

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def parse_pdf(self) -> ParseResult:
        result = ParseResult(source_file=self.source_file)
        layout = ColumnLayout()

        try:
            pdf = pdfplumber.open(self.file_path, password=self.password or "")
        except Exception as exc:  # noqa: BLE001
            if _looks_like_password_error(exc):
                raise PermissionError(
                    "This PDF is password-protected. Enter the correct password "
                    "and try again."
                ) from exc
            raise RuntimeError(f"Failed to open PDF: {exc}") from exc

        any_words = False
        date_lines_seen: int = 0  # count of date-starting visual lines across all pages

        with pdf:
            for page_idx, page in enumerate(pdf.pages, start=1):
                txns, errors, debug, layout, page_date_lines = self._parse_page(
                    page, page_idx, layout
                )
                if txns or errors or debug:
                    any_words = True
                result.transactions.extend(txns)
                result.errors.extend(errors)
                result.debug.extend(debug)
                result.pages_parsed += 1
                date_lines_seen += page_date_lines

        if not any_words:
            raise ValueError(
                "No text could be extracted from this PDF. "
                "Scanned / image-only PDFs are not supported."
            )

        # ---- Inline validation (spec item 8) ---------------------------------
        # We counted date-starting visual lines during the main parse — no
        # need to re-open the PDF. Compare with blocks actually processed.
        self._check_transaction_count(date_lines_seen, result)

        # Final balance-delta sanity sweep across the full transaction list.
        # This catches the rare case where positional assignment was wrong
        # because column centers were too close (debit/credit ambiguous).
        self._fix_directions_with_running_balance(result.transactions, result.debug)

        return result

    # ------------------------------------------------------------------
    # Page parsing
    # ------------------------------------------------------------------

    def _parse_page(
        self,
        page,
        page_idx: int,
        layout: ColumnLayout,
    ) -> Tuple[List[Transaction], List[ParseError], List[DebugRow], ColumnLayout, int]:
        """Parse one page using a 3-tier strategy.

        **Tier 1 — extract_tables() (PRIMARY)**
        pdfplumber uses the PDF's printed table-border lines to segment rows.
        Each row is already a clean list of cells; no Y-grouping, no word
        merging, no coordinate analysis needed.  This is exactly what the
        user's working v1/v2 scripts use and it is the most reliable strategy
        for SBI statements, which always have visible table borders.

        **Tier 2 — extract_words() + positional analysis (SECONDARY)**
        Falls back to the word-coordinate approach when extract_tables() yields
        no transaction rows (e.g. older PDFs without explicit border lines).

        **Tier 3 — extract_text() + line accumulation (TERTIARY)**
        Last resort: raw text lines, accumulate until the line ends with 3
        numbers, then slice amounts from the right.

        Returns a 5-tuple:
          ``(transactions, errors, debug_rows, updated_layout, date_line_count)``
        """

        # ── Tier 1: extract_tables() ───────────────────────────────────────
        txns, errors, debug, date_line_count = self._parse_page_tables(
            page, page_idx
        )
        if txns:
            logger.debug(
                "Page %d: table strategy produced %d txns", page_idx, len(txns)
            )
            return txns, errors, debug, layout, date_line_count

        # ── Tier 2: extract_words() + positional analysis ──────────────────
        # NOTE: ``use_text_flow=True`` respects the PDF's underlying text
        # stream order. This matters because when two adjacent columns
        # (e.g. Description and Ref No.) print right up against each
        # other with no whitespace gap on the page, the default
        # coordinate-only grouping can interleave their characters into
        # a single junk "word". Following the text flow keeps the
        # printed tokens distinct, which is exactly what positional
        # analysis needs.
        try:
            words = page.extract_words(
                use_text_flow=True,
                keep_blank_chars=False,
                x_tolerance=WORD_X_TOLERANCE,
                y_tolerance=WORD_Y_TOLERANCE,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("extract_words failed on page %d: %s", page_idx, exc)
            words = []

        if words:
            lines = _group_into_lines(words)

            # Detect / update the column layout. We only adopt new columns;
            # already-known columns are kept (continuation pages may have
            # slightly shifted headers, which would otherwise jitter).
            for line in lines:
                new_layout = _detect_header_layout(line)
                if new_layout is not None:
                    layout.merge_from(new_layout)
                    if layout.has_money_columns():
                        break

            # Split any words whose bbox straddles a column boundary.
            if layout.has_money_columns():
                words = self._split_spanning_words(page, words, layout)
                lines = _group_into_lines(words)

            # Count date-starting lines for validation.
            date_line_count = sum(
                1 for ln in lines if ln and looks_like_date(ln[0]["text"])
            )

            blocks = self._group_into_blocks(lines)
            blocks = self._split_merged_blocks(blocks, layout)

            previous_balance: Optional[float] = None
            for block in blocks:
                t, e, d = self._parse_block(block, layout, page_idx, previous_balance)
                if d is not None:
                    debug.append(d)
                if t is not None:
                    txns.append(t)
                    if t.balance:
                        previous_balance = t.balance
                if e is not None:
                    errors.append(e)

            if txns:
                logger.debug(
                    "Page %d: positional strategy produced %d txns",
                    page_idx, len(txns),
                )
                return txns, errors, debug, layout, date_line_count

        # ── Tier 3: extract_text() + line accumulation ─────────────────────
        logger.debug(
            "Page %d: table+words both empty — falling back to text accumulation",
            page_idx,
        )
        txns, errors, debug, date_line_count = self._parse_page_text(
            page, page_idx
        )
        return txns, errors, debug, layout, date_line_count

    def _parse_page_tables(
        self,
        page,
        page_idx: int,
    ) -> Tuple[List[Transaction], List[ParseError], List[DebugRow], int]:
        """Parse one PDF page using pdfplumber's table extractor.

        This is the same strategy used by the working v1/v2 converter scripts:
        ``pdfplumber.extract_tables()`` uses the PDF's printed cell-border lines
        to segment the table, which cleanly separates each transaction into its
        own row with pre-split cells.  No Y-coordinate grouping, no word-merging
        issues — each row maps 1:1 to one transaction.

        Returns ``(transactions, errors, debug_rows, date_line_count)``.
        """
        try:
            tables = page.extract_tables() or []
        except Exception as exc:  # noqa: BLE001
            logger.warning("extract_tables failed on page %d: %s", page_idx, exc)
            return [], [], [], 0

        if not tables:
            return [], [], [], 0

        # Use the largest table (most rows) — the transaction table.
        table = max(tables, key=len)
        if not table:
            return [], [], [], 0

        # Find the header row and build the column map.
        col_map: Dict[str, int] = {}
        data_start = 0
        for i, row in enumerate(table[:10]):
            if not row:
                continue
            candidate = _map_table_columns(row)
            if len(candidate) >= 3:   # at least date + one money column + balance
                col_map = candidate
                data_start = i + 1
                break

        txns: List[Transaction] = []
        errors: List[ParseError] = []
        debug: List[DebugRow] = []
        date_line_count = 0

        for row in table[data_start:]:
            if not row or not any(row):
                continue
            t, e, d = _parse_table_row(row, col_map, page_idx, self.source_file)
            if t is not None:
                date_line_count += 1
                txns.append(t)
            if e is not None:
                # Only count rows that HAD a date as date_lines
                raw_date = _safe_cell(row, col_map.get("date")) if col_map else _safe_cell(row, 0)
                if _DATE_CELL_RE.match(raw_date):
                    date_line_count += 1
                errors.append(e)
            if d is not None:
                debug.append(d)

        return txns, errors, debug, date_line_count

    # ------------------------------------------------------------------
    # Text-accumulation fallback page parser
    # ------------------------------------------------------------------

    def _parse_page_text(
        self,
        page,
        page_idx: int,
    ) -> Tuple[List[Transaction], List[ParseError], List[DebugRow], int]:
        """Text-based fallback: extract_text() + line accumulation.

        Used when the positional (extract_words) approach finds 0
        transactions on a page — typically because no column-header row
        was detected or the word ordering is unusual.

        Returns ``(transactions, errors, debug_rows, date_line_count)``.
        """
        try:
            raw_text = page.extract_text() or ""
        except Exception as exc:  # noqa: BLE001
            logger.warning("extract_text failed on page %d: %s", page_idx, exc)
            return [], [], [], 0

        if not raw_text.strip():
            return [], [], [], 0

        # Count date-starting lines for validation.
        date_re_simple = re.compile(r"^\d{2}-\d{2}-\d{2}\b")
        date_line_count = sum(
            1 for ln in raw_text.splitlines()
            if date_re_simple.match(ln.strip())
        )

        acc_strings = _accumulate_text_transactions(raw_text)

        txns: List[Transaction] = []
        errors: List[ParseError] = []
        debug: List[DebugRow] = []

        for acc in acc_strings:
            t, e, d = _parse_text_transaction(acc, page_idx, self.source_file)
            if d is not None:
                debug.append(d)
            if t is not None:
                txns.append(t)
            if e is not None:
                errors.append(e)

        return txns, errors, debug, date_line_count

    # ------------------------------------------------------------------
    # Spanning-word splitter (conservative: only splits glued refs)
    # ------------------------------------------------------------------

    def _split_spanning_words(
        self,
        page,
        words: List[Word],
        layout: ColumnLayout,
    ) -> List[Word]:
        """Split a word ONLY when it has a glued-on reference suffix.

        Real SBI statements occasionally typeset the description text and
        the ref-no with zero whitespace between them, e.g. the underlying
        text stream contains ``UPI/DR/RAMESH/IPOS/rameshk123456789012``
        and pdfplumber returns it as a single "word".

        Splitting any word that *crosses* a column boundary is too
        aggressive: it chops description tail-chars that simply extend
        slightly past the column header (e.g. ``LANDLORD`` ->
        ``LANDLORD`` + lost chars). Instead, we only split when:

            (a) the word's right edge extends past the description column,
                AND
            (b) the trailing chars of the word's TEXT look like a
                reference: at least 8 digits, optionally prefixed by
                up to 4 letters (e.g. ``IMP0101260001``).

        The split position is computed proportionally from char count,
        which is accurate enough because reference numbers are
        monospaced-feeling (digits) so the per-char width is uniform.
        """
        desc_range = layout.description
        if desc_range is None:
            return list(words)
        desc_right = desc_range[1]

        # Matches a ref-suffix at the end of a token. Up to 4 letters,
        # then 8-16 digits. Case-insensitive.
        suffix_re = re.compile(r"([A-Z]{0,4}\d{8,16})$", re.IGNORECASE)

        out: List[Word] = []
        for w in words:
            # Quick guard: skip narrow words that don't reach the ref area.
            if w["x1"] <= desc_right + 5:
                out.append(w)
                continue
            text = w["text"]
            m = suffix_re.search(text)
            if not m:
                out.append(w)
                continue
            split_idx = m.start()
            if split_idx == 0:
                # The whole word is the ref; the column-routing in
                # _assign_using_layout will place it correctly.
                out.append(w)
                continue

            # Proportional split: assume uniform char width across the
            # word's bbox (good enough for the kind of suffix-splits
            # we care about, where the suffix is mostly digits).
            total_chars = len(text)
            full_width = w["x1"] - w["x0"]
            char_width = full_width / total_chars
            cut_x = w["x0"] + char_width * split_idx
            top = w["top"]
            bottom = w.get("bottom", top + 1)

            leading_text = text[:split_idx].rstrip()
            trailing_text = text[split_idx:]
            if leading_text:
                out.append({
                    "text": leading_text,
                    "x0": w["x0"],
                    "x1": cut_x,
                    "top": top,
                    "bottom": bottom,
                })
            if trailing_text:
                out.append({
                    "text": trailing_text,
                    "x0": cut_x,
                    "x1": w["x1"],
                    "top": top,
                    "bottom": bottom,
                })

        return out

    # ------------------------------------------------------------------
    # Block grouping (visual lines -> transaction blocks)
    # ------------------------------------------------------------------

    def _group_into_blocks(self, lines: List[Line]) -> List[Line]:
        """Group visual lines into transaction blocks.

        A block opens on any line whose **leading token** matches a
        ``DD-MM-YY`` date pattern. Non-date lines extend the current
        block as continuation. Noise lines and reprinted column headers
        are discarded before grouping.

        Multi-line transaction layout
        -----------------------------
        Some SBI PDFs render a transaction across two visual rows:

            Row 1  06-04-26  UPI/.../description
            Row 2            -  0  76.00  8366.23

        Row 2 has no leading date, so it is a continuation and is
        appended to the open block. ``_line_is_amounts_only`` detects
        that row 2 contains *only* amount tokens and closes the block
        immediately.  This is the critical guard that prevents any footer
        or header text sitting between the amounts row and the *next*
        transaction's date from being absorbed into this transaction's
        description.

        Cross-transaction contamination guards
        ---------------------------------------
        1. ``is_noise_line`` is applied unconditionally before any block
           decision — footer phrases are silently dropped.
        2. A line whose first word matches ``DD-MM-YY`` always starts a
           new block (commits any open block first).
        3. An amounts-only continuation line (no alphabetic words, ≥1
           decimal number) triggers early finalisation of the open block.
        4. Any other continuation text is appended only when an open
           block already exists (orphaned text before the first transaction
           is discarded).
        """
        blocks: List[Line] = []
        current: Optional[Line] = None

        for line in lines:
            if not line:
                continue
            text = _line_text(line)

            # ---- Drop noise unconditionally (applies to continuation too) ----
            if is_noise_line(text):
                continue

            # ---- Drop reprinted column-header rows ----
            lowered = text.lower()
            if sum(1 for tok in HEADER_TOKENS if tok in lowered) >= 3:
                continue

            first = line[0]["text"]
            if looks_like_date(first):
                # A new transaction starts here. Commit the previous block
                # first so we never append across transaction boundaries.
                if current is not None:
                    blocks.append(current)
                current = list(line)
            else:
                # Continuation line: only append if we already have an
                # open block (avoids orphaned text before the first txn).
                if current is not None:
                    current.extend(line)

                    # --- Early-finalisation (key fix for multi-line layout) ---
                    # SBI sometimes places debit/credit/balance on a separate
                    # row below the description row.  Once we detect that a
                    # continuation line contains *only* amount tokens (no
                    # alphabetic narration), the transaction is complete.
                    # Closing the block here means any footer text that appears
                    # between the amounts line and the next transaction's date
                    # is NOT appended to this transaction's description.
                    if _line_is_amounts_only(line):
                        blocks.append(current)
                        current = None

        if current is not None:
            blocks.append(current)

        return blocks

    def _split_merged_blocks(
        self,
        blocks: List[Line],
        layout: ColumnLayout,
    ) -> List[Line]:
        """Safety-net: split any block that contains more than one date token
        at the date-column X position.

        Even with the fixed sequential ``_group_into_lines`` there is a small
        risk that two transaction rows end up in the same block if their ``top``
        coordinates differ by exactly ``LINE_Y_TOLERANCE``.  A second line of
        evidence — the X position of date tokens within the block — is used to
        detect and repair such merges.

        Detection rule
        --------------
        Walk through the block's words sorted by (top, x0).  Whenever we see a
        word that (a) matches the ``DD-MM-YY`` date pattern AND (b) whose x0 is
        close to the expected date-column position (within 20 px), AND (c) it
        is *not* the very first word we've processed — we treat it as the start
        of a new embedded transaction and split there.

        The x-position guard is critical: embedded dates in narrations like
        "EMI DUE 01-03-26" must NOT trigger a split; they are not at the
        left-margin date column.
        """
        # ---- Date-column X reference ----
        # Used to distinguish "real" transaction-date tokens from embedded
        # dates inside narrations (e.g. "EMI DUE 01-03-26").
        if layout.date is not None:
            date_x_lo, date_x_hi = layout.date
            date_x_mid = (date_x_lo + date_x_hi) / 2.0
            # Tight tolerance so we ONLY match the Txn Date column, not
            # the adjacent Value Date column (which is ~50 px to the right).
            date_x_tol = max(15.0, (date_x_hi - date_x_lo) / 2.0 + 5.0)
        else:
            date_x_mid = None
            date_x_tol = 20.0   # tighter than before to avoid val-date false hits

        # ---- Value-date column X reference (used to *exclude* val-date) ----
        # SBI statements always print two date columns: Txn Date and Value
        # Date.  The value date is ~50 px to the right of the txn date.
        # We must NOT treat the value-date token as the start of a new
        # transaction.
        val_date_lo: Optional[float] = None
        val_date_hi: Optional[float] = None
        if layout.value_date is not None:
            val_date_lo, val_date_hi = layout.value_date

        result: List[Line] = []

        for block in blocks:
            if len(block) < 4:
                result.append(block)
                continue

            # Sort by (top, x0) — visual reading order within the block.
            ordered = sorted(block, key=lambda w: (round(w["top"], 1), w["x0"]))

            # Determine date-column reference from the first date token if
            # no layout is available yet.
            first_date_x: Optional[float] = None
            for w in ordered:
                if looks_like_date(w["text"]):
                    first_date_x = w["x0"]
                    break

            ref_x = date_x_mid if date_x_mid is not None else first_date_x

            sub: Line = []
            for i, w in enumerate(ordered):
                is_date = looks_like_date(w["text"])

                # Is this token near the Txn Date column?
                near_txn_date_col = (
                    ref_x is None
                    or abs(w["x0"] - ref_x) <= date_x_tol
                )

                # Is this token inside the Value Date column?  If so, it
                # is the *value date* of the SAME transaction, NOT a new one.
                in_val_date_col = (
                    val_date_lo is not None
                    and val_date_lo - 10 <= w["x0"] <= val_date_hi + 10  # type: ignore[operator]
                )

                # Heuristic guard when layout is unknown: if the current
                # sub-block contains ONLY date tokens so far (txn-date
                # just placed, nothing else yet), the new date token is
                # very likely the value date of that same transaction.
                sub_has_only_dates = bool(sub) and all(
                    looks_like_date(sw["text"]) for sw in sub
                )

                should_split = (
                    i > 0
                    and is_date
                    and near_txn_date_col
                    and not in_val_date_col
                    and not sub_has_only_dates
                )

                if should_split:
                    if sub:
                        result.append(sub)
                    sub = [w]
                else:
                    sub.append(w)

            if sub:
                result.append(sub)

        return result

    # ------------------------------------------------------------------
    # Per-block positional analysis (the heart of the parser)
    # ------------------------------------------------------------------

    def _parse_block(
        self,
        block: Line,
        layout: ColumnLayout,
        page_idx: int,
        previous_balance: Optional[float],
    ) -> Tuple[Optional[Transaction], Optional[ParseError], Optional[DebugRow]]:
        """Convert a transaction block (list of words) into a Transaction.

        Returns ``(transaction, error, debug_row)``:
        * ``transaction`` is set when parsing succeeded;
        * ``error`` is set when the block could not be parsed (and
          ``transaction`` is None) — so the row is *recorded*, never
          silently dropped, per the spec;
        * ``debug_row`` is always set so the user can see the decision.
        """
        # Sort visual order (top, x0) for stable token ordering.
        ordered = sorted(block, key=lambda w: (round(w["top"], 1), w["x0"]))

        raw = _line_text(ordered)
        tokens = [w["text"] for w in ordered]

        # First token MUST be a date by construction (block opens on a date).
        if not ordered or not looks_like_date(ordered[0]["text"]):
            return (
                None,
                ParseError(page_idx, raw, "block does not start with a date"),
                DebugRow(page_idx, raw, tokens, "no leading date"),
            )

        date_str = ordered[0]["text"]
        # If the second token is also a date, it's the "Value Date" — skip it.
        first_data_idx = 1
        if len(ordered) > 1 and looks_like_date(ordered[1]["text"]):
            first_data_idx = 2

        data_words = ordered[first_data_idx:]

        # -------- 1. Classify every remaining word -----------------------
        # Pre-filter Cr/Dr suffix tokens; they carry no positional value
        # and are not needed once column-based classification is used.
        kept = [w for w in data_words if not looks_like_drcr(w["text"])]

        # -------- 2. Decide which words are money / ref / description -----
        if layout.has_money_columns():
            debit, credit, balance, ref_words, desc_words_extra, decision = (
                self._assign_using_layout(kept, layout)
            )
            base_desc_words: List[Word] = []  # _assign_using_layout returns desc_words_extra
        else:
            # Right-anchor fallback: classify by token type as before
            # (we can't use column positions without a layout).
            amount_words = [w for w in kept if looks_like_amount(w["text"])]
            integer_words = [w for w in kept if looks_like_integer(w["text"])]
            base_desc_words = [
                w for w in kept
                if not looks_like_amount(w["text"]) and not looks_like_integer(w["text"])
            ]
            debit, credit, balance, ref_words, desc_words_extra, decision = (
                self._assign_using_right_anchor(amount_words, integer_words)
            )

        # -------- 3. Build description ---------------------------------
        # Description = words that didn't get assigned to a money/ref
        # column, sorted by visual order so wraps land in the right place.
        desc_words = sorted(
            base_desc_words + desc_words_extra,
            key=lambda w: (round(w["top"], 1), w["x0"]),
        )
        description = clean_description(" ".join(w["text"] for w in desc_words))

        # Final safety net: if description still ends with what looks
        # like a standalone reference token glued onto the previous
        # word (no whitespace), strip it. This rescues the rare case
        # where char-level splitting could not separate the ref.
        description = _strip_trailing_glued_ref(description)

        # Description MUST never be empty (per spec). Fall back to the
        # raw block text minus its leading date tokens — at least the
        # user sees the source row instead of a blank cell.
        if not description:
            fallback = raw
            # Strip up to 2 leading date tokens (Txn Date + Value Date).
            fallback = re.sub(r"^\s*\d{2}[-/]\d{2}[-/]\d{2,4}\s+", "", fallback)
            fallback = re.sub(r"^\s*\d{2}[-/]\d{2}[-/]\d{2,4}\s+", "", fallback)
            description = clean_description(fallback) or raw
            decision += " | desc-empty -> raw fallback"

        # -------- 4. Validate ------------------------------------------
        date_value = normalize_date(date_str)
        if date_value is None:
            err = ParseError(page_idx, raw, f"bad date token: {date_str!r}")
            dbg = DebugRow(page_idx, raw, tokens, f"bad date | {decision}",
                           date=date_str, debit=debit, credit=credit, balance=balance)
            return None, err, dbg

        if debit == 0.0 and credit == 0.0 and balance == 0.0:
            err = ParseError(page_idx, raw, "no numeric values found")
            dbg = DebugRow(page_idx, raw, tokens, f"no amounts | {decision}",
                           date=date_str, debit=debit, credit=credit, balance=balance)
            return None, err, dbg

        # Sanity check: SBI guarantees only one of debit/credit is non-zero.
        # If both came back set, drop the smaller (likely a misclassified
        # ref number that slipped through). We log the choice in `decision`.
        if debit and credit:
            if debit >= credit:
                credit = 0.0
                decision += " | both set, kept debit"
            else:
                debit = 0.0
                decision += " | both set, kept credit"

        # Final running-balance sanity flip (per-page; the parse_pdf
        # driver runs another sweep across the whole file).
        before_fix = (debit, credit)
        debit, credit = correct_direction_from_balance(
            debit, credit, balance, previous_balance
        )
        if before_fix != (debit, credit):
            decision += " | flipped via balance delta"

        # -------- 5. Structured-field extraction -----------------------
        # Always run, even when ``description`` came from the raw-line
        # fallback, so analytics columns are populated for every row.
        struct = parse_description_structure(description)

        txn = Transaction(
            date=date_value,
            description=description,
            debit=float(debit),
            credit=float(credit),
            balance=float(balance),
            source=self.BANK_NAME,
            source_file=self.source_file,
            txn_mode=struct["txn_mode"],
            txn_reference=struct["txn_reference"],
            txn_vpa=struct["txn_vpa"],
            txn_counterparty=struct["txn_counterparty"],
            txn_bank=struct["txn_bank"],
            txn_phone=struct["txn_phone"],
            txn_raw_description=struct["txn_raw_description"],
        )
        struct_summary = (
            f"mode={struct['txn_mode']} "
            f"ref={struct['txn_reference']} "
            f"vpa={struct['txn_vpa']} "
            f"cp={struct['txn_counterparty']}"
        )
        dbg = DebugRow(
            page=page_idx,
            raw=raw,
            tokens=tokens,
            decision=f"{decision} | {struct_summary}",
            date=date_str,
            debit=float(debit),
            credit=float(credit),
            balance=float(balance),
        )
        return txn, None, dbg

    # ------------------------------------------------------------------
    # Numeric-token -> column assignment
    # ------------------------------------------------------------------

    def _assign_using_layout(
        self,
        words: List[Word],
        layout: ColumnLayout,
    ) -> Tuple[float, float, float, List[Word], List[Word], str]:
        """Position-based assignment when we know the column layout.

        Every word is routed to a logical column by x-center distance —
        regardless of whether it looks like a number, an integer or
        free text. Money columns extract the rightmost numeric token
        assigned to them; the Ref column collects everything that
        lands under it (so alphanumeric refs like ``N0101260000001``
        or ``IMP0101260001`` are correctly *removed* from the
        description). Words that don't fall under any known column
        are returned as ``desc_words`` for the caller to include in
        the description.

        Returns ``(debit, credit, balance, ref_words, desc_words, decision)``.
        """
        debit = 0.0
        credit = 0.0
        balance = 0.0
        ref_words: List[Word] = []
        desc_words: List[Word] = []

        # Bucket words by their nearest known column.
        buckets: Dict[str, List[Word]] = {
            "date": [], "value_date": [], "description": [],
            "ref": [], "debit": [], "credit": [], "balance": [],
        }
        unassigned: List[Word] = []
        for w in words:
            x_center = (w["x0"] + w["x1"]) / 2.0
            col = _assign_to_column(
                layout,
                x_center,
                candidates=("date", "value_date", "description",
                            "ref", "debit", "credit", "balance"),
            )
            if col is None:
                unassigned.append(w)
            else:
                buckets[col].append(w)

        # ---- Money columns: take the rightmost numeric in each ----
        def _pick_money(col_name: str) -> Optional[float]:
            best: Optional[Tuple[float, float]] = None  # (x1, value)
            for w in buckets[col_name]:
                t = w["text"]
                if not (looks_like_amount(t) or looks_like_integer(t)):
                    continue
                # Skip long integers that are reference / phone numbers
                # (≥ 8 digits, no decimal point). These land in money-column
                # buckets when _split_spanning_words separates a ref like
                # "/SBIN/9000000001" into "/SBIN/" + "9000000001"; the digit
                # part then sits at an x-center close to the debit column.
                if looks_like_reference(t):
                    ref_words.append(w)  # track it, but don't treat as money
                    continue
                v = to_float(t)
                if v is None:
                    continue
                if best is None or w["x1"] > best[0]:
                    best = (w["x1"], v)
            return best[1] if best else None

        b = _pick_money("balance")
        d = _pick_money("debit")
        c = _pick_money("credit")
        balance = b if b is not None else 0.0
        debit = d if d is not None else 0.0
        credit = c if c is not None else 0.0

        # ---- Money columns: any *non-numeric* token that landed here
        # is treated as description (rare; happens if a stray word
        # bbox-overlaps a money column). We don't want to silently
        # drop information.
        #
        # Exception: dash variants ("-", "–", "—") represent an *empty*
        # amount cell in SBI statements (e.g. the Debit column shows "-"
        # when the transaction is a credit). Including them in the
        # description produces outputs like "RAMESH - ZOMATO", which
        # falsely suggests the two are one transaction. Skip them entirely.
        _EMPTY_CELL_TOKENS = {"-", "--", "–", "—", "NIL", "nil", "Nil", "NA", "N/A"}
        for col in ("debit", "credit", "balance"):
            for w in buckets[col]:
                t = w["text"]
                if looks_like_amount(t) or looks_like_integer(t):
                    continue
                if t in _EMPTY_CELL_TOKENS:
                    continue
                desc_words.append(w)

        # ---- Ref column: everything in it is a reference and is
        # intentionally excluded from the description.
        ref_words.extend(buckets["ref"])

        # ---- Description column + unassigned: go into the description.
        # Date / value_date buckets we ignore (already consumed up-front).
        desc_words.extend(buckets["description"])
        desc_words.extend(unassigned)

        decision = (
            f"layout: D={debit} C={credit} B={balance} "
            f"ref={len(ref_words)} desc={len(desc_words)}"
        )
        return debit, credit, balance, ref_words, desc_words, decision

    def _assign_using_right_anchor(
        self,
        amount_words: List[Word],
        integer_words: List[Word],
    ) -> Tuple[float, float, float, List[Word], List[Word], str]:
        """Right-anchor assignment when no header layout is available.

        Rules (per spec):
        * Last numeric (rightmost) = Balance.
        * Second last numeric      = Credit OR Debit (closer-to-balance -> Credit).
        * Third last numeric       = Debit (when present).

        Standalone long integers between the description and the
        rightmost numerics are reference numbers and are skipped.
        """
        debit = 0.0
        credit = 0.0
        balance = 0.0
        ref_words: List[Word] = []
        leftover: List[Word] = []

        # Build the ordered list of "money candidates" (decimals first
        # because they're unambiguous; pure integers may be refs).
        # Sort everything by x_center so the right-anchor rule applies.
        all_money = [(w, (w["x0"] + w["x1"]) / 2.0) for w in amount_words]
        all_money.sort(key=lambda t: t[1])

        # Integers that look like reference numbers are excluded from the
        # money pool; the rest are appended (could be plain integer
        # balances/amounts in older SBI variants).
        for w in integer_words:
            if looks_like_reference(w["text"]):
                ref_words.append(w)
            else:
                all_money.append((w, (w["x0"] + w["x1"]) / 2.0))
        all_money.sort(key=lambda t: t[1])

        decision_parts: List[str] = []

        if not all_money:
            return 0.0, 0.0, 0.0, ref_words, leftover, "right-anchor: no numerics"

        if len(all_money) == 1:
            balance = to_float(all_money[0][0]["text"]) or 0.0
            decision_parts.append("balance-only")
        elif len(all_money) == 2:
            balance = to_float(all_money[1][0]["text"]) or 0.0
            amt_w, amt_x = all_money[0]
            bal_x = all_money[1][1]
            # Heuristic: SBI savings rows usually have either Debit+Balance
            # OR Credit+Balance. With no layout we default to Debit (most
            # SBI transactions are UPI debits). The balance-delta sweep
            # in ``parse_pdf`` will flip it if the math disagrees.
            debit = to_float(amt_w["text"]) or 0.0
            decision_parts.append("default-debit (gap=%.1f)" % (bal_x - amt_x))
        else:
            # 3+ money tokens: take rightmost as balance, next as credit
            # (closer to balance), next as debit. Extras land in leftover.
            balance = to_float(all_money[-1][0]["text"]) or 0.0
            credit = to_float(all_money[-2][0]["text"]) or 0.0
            debit = to_float(all_money[-3][0]["text"]) or 0.0
            decision_parts.append("3-numeric")
            for w, _ in all_money[:-3]:
                leftover.append(w)

        decision = "right-anchor: " + ", ".join(decision_parts) + (
            f" | D={debit} C={credit} B={balance}"
        )
        return debit, credit, balance, ref_words, leftover, decision

    # ------------------------------------------------------------------
    # Validation: date-line count vs transaction count (inline, no re-open)
    # ------------------------------------------------------------------

    @staticmethod
    def _check_transaction_count(date_lines_seen: int, result: ParseResult) -> None:
        """Compare date-starting lines (counted during the main parse) with
        the number of transaction blocks processed.

        A gap larger than 1 is reported as a warning so users can investigate
        via the debug log.  We accept a tolerance of 1 because the first
        date-starting line in the PDF is sometimes the column-header row (which
        begins with "Txn Date" — not a real ``DD-MM-YY`` token — but headers
        are filtered by ``_group_into_blocks`` before being counted as blocks,
        while our line-counter runs before that filter).
        """
        parsed_count = len(result.transactions)
        error_count  = len(result.errors)
        total_blocks = parsed_count + error_count

        msg = (
            f"Validation: {date_lines_seen} date-starting lines seen, "
            f"{parsed_count} transactions parsed, {error_count} blocks skipped."
        )
        logger.info(msg)

        if date_lines_seen > 0 and total_blocks < date_lines_seen - 1:
            gap = date_lines_seen - total_blocks
            warn = (
                f"⚠ {gap} date-starting lines were not converted to transactions "
                f"({date_lines_seen} detected vs {total_blocks} blocks processed). "
                "Review the debug log for skipped rows."
            )
            result.warnings.append(warn)
            logger.warning(warn)

    # ------------------------------------------------------------------
    # Final pass: running-balance direction sanity sweep
    # ------------------------------------------------------------------

    @staticmethod
    def _fix_directions_with_running_balance(
        transactions: List[Transaction],
        debug: List[DebugRow],
    ) -> None:
        """Walk the transactions once more, flipping debit<->credit when
        the balance delta proves the original direction was wrong.

        We only ever flip — magnitudes are preserved. A debug entry is
        emitted whenever a flip occurs so the trace remains transparent.
        """
        prev_balance: Optional[float] = None
        # Quick map back to debug rows by index (parse_pdf appended them
        # in the same order as transactions).
        debug_by_idx = {i: d for i, d in enumerate(debug)}
        txn_count = 0
        for txn in transactions:
            if prev_balance is not None and txn.balance:
                amount = txn.debit or txn.credit
                delta = round(txn.balance - prev_balance, 2)
                if amount and abs(abs(delta) - amount) <= 0.01:
                    if delta > 0 and txn.debit and not txn.credit:
                        txn.debit, txn.credit = 0.0, amount
                        d = debug_by_idx.get(txn_count)
                        if d is not None:
                            d.decision += " | global-flip: debit->credit"
                            d.debit, d.credit = 0.0, amount
                    elif delta < 0 and txn.credit and not txn.debit:
                        txn.debit, txn.credit = amount, 0.0
                        d = debug_by_idx.get(txn_count)
                        if d is not None:
                            d.decision += " | global-flip: credit->debit"
                            d.debit, d.credit = amount, 0.0
            if txn.balance:
                prev_balance = txn.balance
            txn_count += 1
