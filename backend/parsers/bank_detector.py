"""Auto-detect the issuing bank of a PDF statement.

Detection is done by reading the first 1–2 pages with ``pdfplumber`` and
looking for bank-specific marker phrases printed on every statement. The
function is deliberately conservative: when no marker matches it returns
``None`` so the caller can ask the user to pick a bank manually instead
of silently misclassifying.
"""

from __future__ import annotations

import logging
from typing import Optional

import pdfplumber


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Bank marker phrases (lower-cased; matched as substring on extract_text())
# ---------------------------------------------------------------------------

SLICE_MARKERS = (
    "slice small finance bank",
    "help@slice.bank.in",
    "date details ref no",  # the Slice savings column header
)

# Slice Credit Card markers — empirically verified against all three
# CC PDF flavours in the test corpus:
#
#   * "refunds & repayments" — Slice's exact section heading. SBI CC
#     calls this column "Payments, Reversals & other Credits" so this
#     phrase NEVER appears in SBI CC.
#   * "min amount due" — Slice writes "Min amount due"; SBI writes
#     "Minimum Amount Due" (does NOT contain "min amount due" as a
#     substring after lower-casing).
#   * "spends" — Slice's exact section heading. SBI uses "Purchases
#     & Other Debits" so this token never appears in SBI CC.
#
# Generic phrases like "credit card statement" / "total amount due" are
# DELIBERATELY excluded because they appear on SBI CC too.
SLICE_CC_MARKERS = (
    "refunds & repayments",
    "min amount due",
    "spends",
)

SBI_MARKERS = (
    "state bank of india",
    "sbi.co.in",
    "onlinesbi",
)

# SBI Credit Card markers — distinct from SBI Savings markers because the
# CC statement is issued by a separate SBI subsidiary ("SBI Cards and
# Payment Services Limited") and never mentions "State Bank of India" /
# "sbi.co.in". We check these BEFORE the savings markers in
# :func:`detect_bank` so a SBI CC PDF is never mis-routed.
SBI_CC_MARKERS = (
    "sbi card",
    "sbi cards and payment services",
    "sbicard.com",
    "gstin of sbi card",
)

# Canara markers. The bank name appears in the address block AND in
# multiple footer disclaimers; the column header
# "date particulars deposits withdrawals balance" is unique to Canara
# (SBI uses Debit/Credit, Slice uses Details). Either one is enough but
# we check several so the detector survives PDFs where one phrase has
# unusual hyphenation / wrapping.
CANARA_MARKERS = (
    "canara bank",
    "www.canarabank.com",
    "cnrb0",  # CNRB IFSC prefix
    "date particulars deposits withdrawals balance",
)


# Supported bank IDs returned by :func:`detect_bank`. Keeping these as
# lowercase strings (not enums) so they round-trip cleanly through the
# Streamlit selectbox.
BANK_SLICE = "slice"           # alias kept for backward compatibility
BANK_SLICE_SAVINGS = "slice"   # explicit name for the savings parser
BANK_SLICE_CC = "slice_cc"     # Slice credit card statement
BANK_SBI = "sbi"               # SBI savings account
BANK_SBI_CC = "sbi_cc"         # SBI credit card statement
BANK_CANARA = "canara"


def _scan_first_pages(pdf_path: str, password: str = "", n_pages: int = 2) -> str:
    """Return concatenated, lower-cased text from the first ``n_pages`` pages.

    Returns an empty string when the PDF cannot be opened (the caller is
    responsible for surfacing that to the user via a separate code path —
    this helper never raises).
    """
    try:
        with pdfplumber.open(pdf_path, password=password) as pdf:
            chunks = []
            for page in pdf.pages[: max(1, n_pages)]:
                txt = page.extract_text() or ""
                chunks.append(txt)
        return "\n".join(chunks).lower()
    except Exception as exc:  # noqa: BLE001
        logger.warning("bank-detector: cannot open %s: %s", pdf_path, exc)
        return ""


def detect_bank(pdf_path: str, password: str = "") -> Optional[str]:
    """Return ``"slice"`` / ``"sbi"`` / ``None`` based on first-page markers.

    Why scan two pages?
    Page 1 of a Slice statement contains the customer block + summary;
    the column header "DATE DETAILS REF NO." is reliably present on every
    page, but checking page 2 as well makes the detector robust to PDFs
    where page 1 is a cover sheet.
    """
    text = _scan_first_pages(pdf_path, password=password, n_pages=2)
    if not text:
        return None

    # Slice Credit Card is checked FIRST — it has the most specific
    # markers ("credit card statement", "min amount due") that the
    # savings statement never contains. Order matters: a CC PDF mentions
    # "slice" generically in its glossary, which would false-match
    # SLICE_MARKERS below if we checked savings first.
    if any(m in text for m in SLICE_CC_MARKERS):
        return BANK_SLICE_CC
    # Slice Savings — distinguished from CC by the unique column header
    # "date details ref no." and the absence of CC-specific phrases.
    if any(m in text for m in SLICE_MARKERS):
        return BANK_SLICE_SAVINGS
    # SBI Credit Card — checked BEFORE SBI Savings because the CC PDF
    # never mentions "state bank of india" and the SBI Savings PDF
    # never mentions "sbi card", so the two are unambiguous and the
    # CC check is naturally more specific.
    if any(m in text for m in SBI_CC_MARKERS):
        return BANK_SBI_CC
    # Canara also has very distinctive markers (CNRB IFSC, column header)
    # and we check it before SBI because the Canara statement happens to
    # quote the RBI/banking ombudsman, which contains generic banking
    # phrases that could otherwise false-match.
    if any(m in text for m in CANARA_MARKERS):
        return BANK_CANARA
    if any(m in text for m in SBI_MARKERS):
        return BANK_SBI
    return None
