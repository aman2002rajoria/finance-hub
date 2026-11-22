"""Low-level parsing primitives used by the SBI parser.

This module is deliberately UI-agnostic and import-light: it only needs the
standard library plus :mod:`pandas` (used for the canonical ``Date`` column
in the output). All regexes live here so the parsing rules can be tuned in
a single, well-tested place.

Design notes
------------
The SBI parser is **positional** (it uses
:meth:`pdfplumber.Page.extract_words` and column x-coordinates from the
printed header). This module therefore does NOT do any DR/CR keyword
inference for amount classification — that responsibility has been
removed entirely. The helpers here are deterministic:

* :func:`is_noise_line`              — drop reprinted headers / footers.
* :func:`normalize_date`             — parse SBI's various date strings.
* :func:`to_float`                   — parse a single numeric token.
* :func:`looks_like_amount`/etc.     — token classifiers used during
  positional analysis.
* :func:`correct_direction_from_balance` — purely-arithmetic sanity flip.
* :func:`parse_description_structure` — split a description into
  ``txn_mode`` / ``txn_reference`` / ``txn_vpa`` / ``txn_counterparty``
  / ``txn_raw_description`` so downstream analytics can categorise rows.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd


# ---------------------------------------------------------------------------
# Token-level regexes (no whole-line magic — that lives in the parser)
# ---------------------------------------------------------------------------

# A bare date token (used to detect transaction starts and value-date skips).
DATE_TOKEN_REGEX = re.compile(r"^\d{2}[-/]\d{2}[-/]\d{2,4}$")

# A numeric token that is *unambiguously* an amount because it has a comma
# (Indian thousands separator) or a decimal point. Examples matched:
#   "1,000",  "1,000.00",  "1,23,456.78",  "500.00",  "-200.50",  "0.00"
# NOT matched: pure integers like "12345" — those go through
# ``looks_like_integer`` and are classified by column position.
AMOUNT_TOKEN_REGEX = re.compile(
    r"^-?\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?$"
    r"|^-?\d+\.\d{1,2}$"
)

# Pure integer (no separators, no decimal). Could be a balance like "12345"
# or a reference number like "123456789012". The parser decides by x-column.
INTEGER_TOKEN_REGEX = re.compile(r"^-?\d+$")

# Standalone Cr/Dr suffix tokens occasionally produced by pdfplumber when
# the PDF prints amounts as ``500.00 Cr``. Skipped during numeric counting.
DRCR_TOKEN_REGEX = re.compile(r"^(?:Cr|Dr|CR|DR|cr|dr)$")


# ---------------------------------------------------------------------------
# Whole-line noise filter (used for header / footer detection)
# ---------------------------------------------------------------------------

NOISE_PATTERNS: List[re.Pattern[str]] = [
    # ---- page structure ----
    re.compile(r"\bpage\s*\d+\s*of\s*\d+\b", re.IGNORECASE),
    re.compile(r"\bstatement\s+summary\b", re.IGNORECASE),
    re.compile(r"\baccount\s+statement\b", re.IGNORECASE),
    re.compile(r"\bopening\s+balance\b", re.IGNORECASE),
    re.compile(r"\bclosing\s+balance\b", re.IGNORECASE),
    re.compile(r"\bbalance\s+brought\s+forward\b", re.IGNORECASE),
    re.compile(r"\bbalance\s+carried\s+forward\b", re.IGNORECASE),
    re.compile(r"\bthis\s+is\s+a\s+computer\s+generated", re.IGNORECASE),
    re.compile(r"^\s*\*+\s*end\s+of\s+statement\s*\*+\s*$", re.IGNORECASE),
    re.compile(r"^\s*from\s*:.*\bto\s*:", re.IGNORECASE),
    # ---- account metadata ----
    re.compile(r"\b(account|customer)\s+(no|number)\b", re.IGNORECASE),
    re.compile(r"\bifs\s*code\b|\bifsc\b", re.IGNORECASE),
    re.compile(r"\bmicr\s*code\b", re.IGNORECASE),
    re.compile(r"\bbranch\s*(name|code)\b", re.IGNORECASE),
    re.compile(r"\bnominee\b", re.IGNORECASE),
    re.compile(r"\bcontinued\b", re.IGNORECASE),
    re.compile(r"\bdetailed\s+statement\b", re.IGNORECASE),
    re.compile(r"\bstate\s+bank\s+of\s+india\b", re.IGNORECASE),
    re.compile(r"\bgenerated\s+(on|by)\b", re.IGNORECASE),
    re.compile(r"\bdrawing\s+power\b", re.IGNORECASE),
    # ---- SBI website / customer-care footers ----
    re.compile(r"sbi\.co\.in", re.IGNORECASE),
    re.compile(r"onlinesbi\.", re.IGNORECASE),
    re.compile(r"\bcustomer\s*care\b", re.IGNORECASE),
    re.compile(r"\bcontact\s*(us|center|centre)\b", re.IGNORECASE),
    re.compile(r"\btoll[\s\-]?free\b", re.IGNORECASE),
    re.compile(r"\bhelpline\b", re.IGNORECASE),
    # ---- URLs and email addresses ----
    re.compile(r"https?://", re.IGNORECASE),
    re.compile(r"\bwww\.", re.IGNORECASE),
    re.compile(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}", re.IGNORECASE),
    # ---- common footer / greeting phrases ----
    re.compile(r"^\s*welcome\b", re.IGNORECASE),
    re.compile(r"\bthank\s+you\b", re.IGNORECASE),
    re.compile(r"\bvisit\s+us\b", re.IGNORECASE),
    re.compile(r"\bfor\s+more\s+information\b", re.IGNORECASE),
    re.compile(r"\bterms\s+(and|&)\s+conditions\b", re.IGNORECASE),
    re.compile(r"\bdisclaimer\b", re.IGNORECASE),
    re.compile(r"\bconfidential\b", re.IGNORECASE),
    re.compile(r"\bauthorised\s+signatory\b", re.IGNORECASE),
    re.compile(r"\bmanager\b.{0,30}\bbranch\b", re.IGNORECASE),
    # ---- summary rows that look like column totals ----
    re.compile(r"\btotal\s+(debit|credit|withdrawals|deposits)\b", re.IGNORECASE),
    re.compile(r"\btransaction\s+details\b", re.IGNORECASE),
    # ---- SBI dispute / grievance / legal footer text ----
    re.compile(r"\b(format\s+statement|dispute|discrepan)\b", re.IGNORECASE),
    re.compile(r"\breported?\s+within\s+\d+\s+days?\b", re.IGNORECASE),
    re.compile(r"\bgrievance\b", re.IGNORECASE),
    re.compile(r"\bredressal\b", re.IGNORECASE),
    re.compile(r"\bbranch\s+manager\b", re.IGNORECASE),
    re.compile(r"\bregistered\s+(office|address)\b", re.IGNORECASE),
    re.compile(r"\bimportant\s+notice\b", re.IGNORECASE),
    re.compile(r"\bplease\s+(note|ensure|contact)\b", re.IGNORECASE),
    re.compile(r"\bif\s+(you|the)\s+(notice|find|see|have)\b", re.IGNORECASE),
    re.compile(r"\b(any\s+discrepancy|unauthorized\s+transaction)\b", re.IGNORECASE),
    re.compile(r"\b(notify|intimate)\s+(your\s+)?branch\b", re.IGNORECASE),
    re.compile(r"\bwill\s+be\s+(reported|investigated|processed)\b", re.IGNORECASE),
    re.compile(r"\bwithin\s+\d+\s+(working\s+)?days?\b", re.IGNORECASE),
    # ---- column-total / carry-forward lines ----
    re.compile(r"^\s*(total|subtotal|grand\s+total)\b", re.IGNORECASE),
    re.compile(r"\bcarried?\s+forward\b", re.IGNORECASE),
    re.compile(r"\bbrought?\s+forward\b", re.IGNORECASE),
]


# Header-row keyword tokens. The parser scans for >=3 of these on a line
# to decide the line is the printed column header (so it can record the
# column x-positions and skip the row itself).
HEADER_TOKENS = (
    "txn date",
    "value date",
    "transaction date",
    "tran date",
    "post date",
    "description",
    "particulars",
    "narration",
    "transaction details",
    "ref no",
    "cheque",
    "reference",
    "debit",
    "credit",
    "withdrawal",
    "deposit",
    "balance",
)


def is_noise_line(line: str) -> bool:
    """``True`` when the line is a header/footer/disclaimer and must be skipped."""
    if not line or not line.strip():
        return True
    for pat in NOISE_PATTERNS:
        if pat.search(line):
            return True
    return False


# ---------------------------------------------------------------------------
# Token classifiers
# ---------------------------------------------------------------------------


def looks_like_date(token: str) -> bool:
    return bool(token) and bool(DATE_TOKEN_REGEX.match(token))


def looks_like_amount(token: str) -> bool:
    """True when the token has a comma or a decimal — definitely a money value."""
    return bool(token) and bool(AMOUNT_TOKEN_REGEX.match(token))


def looks_like_integer(token: str) -> bool:
    """True for pure integers: could be a reference *or* an amount with no decimal."""
    return bool(token) and bool(INTEGER_TOKEN_REGEX.match(token))


def looks_like_drcr(token: str) -> bool:
    return bool(token) and bool(DRCR_TOKEN_REGEX.match(token))


def looks_like_reference(token: str, min_len: int = 8) -> bool:
    """Heuristic used when the printed header has no 'Ref No' column.

    A standalone integer token with at least ``min_len`` digits is almost
    certainly a UPI / cheque reference number, not an amount or a balance.
    SBI reference numbers are typically 10-12 digits.
    """
    if not looks_like_integer(token):
        return False
    digits = token.lstrip("-")
    return len(digits) >= min_len


# ---------------------------------------------------------------------------
# Scalar parsers
# ---------------------------------------------------------------------------


def to_float(token: Optional[str]) -> Optional[float]:
    """Parse a single Indian-formatted number string to ``float``.

    Returns ``None`` if the token cannot be coerced — never raises.
    """
    if token is None:
        return None
    s = str(token).strip()
    if not s:
        return None
    s = re.sub(r"\s*(Cr|Dr|CR|DR)\s*$", "", s, flags=re.IGNORECASE).strip()
    s = s.replace(",", "").replace("\u00a0", "")
    if s in ("", "-", "--"):
        return None
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def normalize_date(raw: Optional[str]) -> Optional[pd.Timestamp]:
    """Convert a date string from an SBI statement into ``pd.Timestamp``.

    Accepts: ``DD-MM-YY``, ``DD-MM-YYYY``, ``DD/MM/YY``, ``DD/MM/YYYY``,
    ``DD Mon YYYY``, ``DD-Mon-YYYY``. Returns ``None`` on failure.
    """
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    for fmt in (
        "%d-%m-%y", "%d-%m-%Y",
        "%d/%m/%y", "%d/%m/%Y",
        "%d %b %Y", "%d-%b-%Y", "%d %B %Y", "%d-%B-%Y",
    ):
        try:
            return pd.Timestamp(datetime.strptime(s, fmt))
        except ValueError:
            continue
    try:
        return pd.to_datetime(s, dayfirst=True, errors="raise")
    except Exception:  # noqa: BLE001
        return None


def clean_description(text: str) -> str:
    """Collapse whitespace and strip control chars from a description fragment."""
    if text is None:
        return ""
    cleaned = re.sub(r"\s+", " ", str(text)).strip()
    return cleaned.strip(" -|\t")


# ---------------------------------------------------------------------------
# Arithmetic-only sanity check (no keyword inference)
# ---------------------------------------------------------------------------


def correct_direction_from_balance(
    debit: float,
    credit: float,
    balance: float,
    previous_balance: Optional[float],
    tolerance: float = 0.01,
) -> Tuple[float, float]:
    """Flip debit<->credit if the running-balance delta proves it's wrong.

    Never invents an amount; the magnitude is preserved. Only used as a
    final safety net when column-position assignment was ambiguous.
    """
    if previous_balance is None:
        return debit, credit

    amount = debit if debit else credit
    if amount == 0.0:
        return debit, credit

    delta = round(balance - previous_balance, 2)
    if abs(abs(delta) - amount) > tolerance:
        return debit, credit  # balance delta != amount -> don't touch

    if delta > 0 and debit:
        return 0.0, amount
    if delta < 0 and credit:
        return amount, 0.0
    return debit, credit


# ---------------------------------------------------------------------------
# Structured description parser
# ---------------------------------------------------------------------------

# Direction tokens that SBI UPI strings insert right after the mode
# (e.g. ``UPI/DR/123456789012/...``). Skipped so txn_reference lands on
# the real transaction ID, not the direction.
DIRECTION_TOKENS = {"DR", "CR", "DEBIT", "CREDIT"}

# A Virtual Payment Address contains ``@``.
VPA_REGEX = re.compile(r"[A-Z0-9._\-]+@[A-Z0-9._\-]+", re.IGNORECASE)

# Known Indian bank IFSC / UPI handle prefixes seen in SBI statements.
# When a slash-delimited part matches one of these it is stored as
# ``txn_bank`` instead of being treated as description or counterparty.
BANK_CODES: set[str] = {
    "SBIN", "HDFC", "ICIC", "KKBK", "UTIB", "YESB", "INDB", "CNRB",
    "BARB", "PUNB", "UBIN", "ALLA", "IOBA", "MAHB", "ANDB", "VIJB",
    "CORP", "IDIB", "FDRL", "KVBL", "AIRP", "PAYTM", "PYTM", "IPOS",
    "NESF", "UJVN", "KLGB", "UCBA", "IDFC", "AUBL", "NSDL", "CITI",
    "HSBC", "SCBL", "DEUT", "TNSC", "MSBL", "APGV", "APBL", "RATN",
}

# Mode-suffix tokens that appear at the very end of SBI UPI descriptions
# (e.g. ``...@ybl/UPI``) — they repeat the mode and should be discarded.
_MODE_SUFFIX_TOKENS = {"UPI", "IMPS", "NEFT", "RTGS", "NACH"}

# SBI (and some other) exports embed the statement date before the channel:
# ``01-12-25 | UPI/DR/123456789012/…`` — the first ``/``-segment is
# ``01-12-25 | UPI``, not bare ``UPI``.
_DATE_PIPE_MODE_RE = re.compile(
    r"^\d{2}[-/]\d{2}[-/]\d{2,4}\s*\|\s*([A-Z0-9_-]+)$",
    re.IGNORECASE,
)


def _coerce_txn_mode_token(token: str) -> str:
    """Normalise the first slash-segment of a description into a channel.

    ``28-06-25 | UPI`` → ``UPI``; ``UPI`` → ``UPI``; everything else is
    upper-cased as-is so downstream rule matching stays predictable.
    """
    token = (token or "").strip()
    if not token:
        return token
    m = _DATE_PIPE_MODE_RE.match(token)
    if m:
        return m.group(1).upper()
    if "|" in token:
        after = token.split("|")[-1].strip()
        if after:
            return after.upper()
    return token.upper()

# An Indian mobile number: exactly 10 digits, starting with 6-9.
_PHONE_REGEX = re.compile(r"^[6-9]\d{9}$")

# A long numeric UPI/IMPS transaction ID: 10–15 digits.
_TXN_ID_REGEX = re.compile(r"^\d{10,15}$")


def _empty_structured() -> Dict[str, Any]:
    return {
        "txn_mode": None,
        "txn_reference": None,
        "txn_vpa": None,
        "txn_counterparty": None,
        "txn_bank": None,
        "txn_phone": None,
        "txn_raw_description": "",
    }


def parse_description_structure(raw_description: Optional[str]) -> Dict[str, Any]:
    """Break a transaction description into structured components.

    Output keys
    -----------
    ``txn_mode``
        Channel/instrument extracted from the first ``/``-segment or the
        first whitespace token: ``UPI``, ``NEFT``, ``IMPS``, ``ATM``,
        ``INTEREST``, …

    ``txn_reference``
        The instrument-level transaction ID.  For SBI UPI this is the
        long numeric string at position 2 (after the direction token at
        position 1).  Example: ``UPI/DR/**123456789012**/RAMESH/…``.

    ``txn_vpa``
        Any ``@``-bearing field (UPI Virtual Payment Address).  Original
        case is preserved, emitted lowercased.  The VPA field is
        excluded from reference/counterparty/bank assignment.

    ``txn_counterparty``
        The merchant / payer / payee name.  For UPI this is the short
        name immediately after the transaction ID (e.g. ``RAMESH``).

    ``txn_bank``
        The payer's or payee's bank, identified from known IFSC/handle
        prefixes (``SBIN``, ``HDFC``, ``KKBK``, …).

    ``txn_phone``
        A 10-digit Indian mobile number when present (common in UPI
        strings like ``…/9000000001/UPI``).

    ``txn_raw_description``
        Original description, whitespace-stripped only.  Always set.

    Parsing rules
    -------------
    * Split on ``/``.
    * ``parts[0]`` → ``txn_mode``.
    * If ``parts[1]`` is a direction token (``DR``/``CR``) skip it.
    * ``parts[2]`` (or ``parts[1]`` if no direction) → ``txn_reference``
      when it looks like a long numeric transaction ID; otherwise it
      becomes the counterparty.
    * Scan remaining parts:
        - ``@`` present → ``txn_vpa`` (first such field wins).
        - Matches BANK_CODES → ``txn_bank`` (first match wins).
        - 10-digit phone pattern → ``txn_phone`` (first match wins).
        - Trailing mode-suffix token (``UPI``, ``IMPS`` …) → discarded.
        - Otherwise, first un-claimed UPPERCASE text → ``txn_counterparty``.
    * If no ``/`` in description: ``txn_mode`` = first token, remaining
      fields ``None`` (inline VPA still scanned).
    * Never raises; always returns a dict with all seven keys.
    """
    if not raw_description:
        return _empty_structured()

    raw = str(raw_description).strip()
    if not raw:
        out = _empty_structured()
        out["txn_raw_description"] = raw
        return out

    out: Dict[str, Any] = _empty_structured()
    out["txn_raw_description"] = raw

    normalised = re.sub(r"\s+", " ", raw.upper()).strip()

    # ---- No "/" → simple keyword extraction --------------------------------
    if "/" not in normalised:
        words = normalised.split()
        if words:
            out["txn_mode"] = words[0]
        vpa = VPA_REGEX.search(raw)
        if vpa:
            out["txn_vpa"] = vpa.group(0).lower()
        return out

    # ---- Split ("/") -------------------------------------------------------
    norm_parts = [p.strip() for p in normalised.split("/") if p.strip()]
    raw_parts  = [p.strip() for p in raw.split("/")        if p.strip()]
    if len(raw_parts) != len(norm_parts):
        raw_parts = norm_parts   # fallback — shouldn't happen in practice

    if not norm_parts:
        return out

    # parts[0] → mode (may be ``DD-MM-YY | UPI`` on SBI exports)
    out["txn_mode"] = _coerce_txn_mode_token(norm_parts[0])

    # Remaining parts to classify
    rest_norm = norm_parts[1:]
    rest_raw  = raw_parts[1:]

    # Skip a leading direction token (DR/CR) so reference lands at pos 2
    if rest_norm and rest_norm[0] in DIRECTION_TOKENS:
        rest_norm = rest_norm[1:]
        rest_raw  = rest_raw[1:]

    # Consume the transaction ID: first remaining part that is a long numeric
    if rest_norm and _TXN_ID_REGEX.match(rest_norm[0]):
        out["txn_reference"] = rest_norm[0]
        rest_norm = rest_norm[1:]
        rest_raw  = rest_raw[1:]

    # Classify what's left — order: counterparty, bank, phone, VPA, suffix
    for norm, raw_p in zip(rest_norm, rest_raw):
        # VPA (contains @) — first match wins
        if "@" in norm:
            if out["txn_vpa"] is None:
                out["txn_vpa"] = raw_p.lower()
            continue
        # Bank code
        if norm in BANK_CODES:
            if out["txn_bank"] is None:
                out["txn_bank"] = norm
            continue
        # Indian mobile number
        if _PHONE_REGEX.match(norm):
            if out["txn_phone"] is None:
                out["txn_phone"] = norm
            continue
        # Mode-suffix repetition (e.g. trailing "UPI") — discard
        if norm in _MODE_SUFFIX_TOKENS and norm == out["txn_mode"]:
            continue
        # First un-claimed text → counterparty; subsequent ones ignored
        # (they may be sub-merchant codes or other metadata)
        if out["txn_counterparty"] is None and norm:
            out["txn_counterparty"] = norm   # uppercased form per spec

    # Final VPA scan: if nothing was found in parts, check inline
    if out["txn_vpa"] is None:
        vpa = VPA_REGEX.search(raw)
        if vpa:
            out["txn_vpa"] = vpa.group(0).lower()

    return out
