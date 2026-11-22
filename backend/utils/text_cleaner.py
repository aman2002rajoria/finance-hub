"""Text-level cleaning helpers shared by text-based parsers (e.g. Slice).

The SBI parser is positional and does its own header/footer filtering via
``utils.helpers.is_noise_line`` with SBI-specific regex patterns. The Slice
parser, by contrast, walks raw lines from ``page.extract_text()`` so it
needs a small, focused set of noise patterns covering Slice's printed
boilerplate (page header, footer, customer block, column header).

Keeping these patterns in a dedicated module — rather than appending them
to the global SBI noise list — prevents accidental cross-contamination
that could break the SBI parser. The two parsers are deliberately
isolated; only the underlying ``Transaction`` dataclass is shared.
"""

from __future__ import annotations

import re
import unicodedata
from typing import List


# ---------------------------------------------------------------------------
# Slice-specific noise patterns
# ---------------------------------------------------------------------------

SLICE_NOISE_PATTERNS: List[re.Pattern[str]] = [
    # Page header: date range like "01 Aug '25 - 16 May '26"
    re.compile(r"^\s*\d{2}\s+[A-Za-z]{3}\s+'\d{2}\s*-\s*\d{2}\s+[A-Za-z]{3}\s+'\d{2}\s*$"),
    # Page number: "1/15"
    re.compile(r"^\s*\d{1,3}\s*/\s*\d{1,3}\s*$"),
    # Column header row (anchored — must contain ALL of these tokens).
    re.compile(r"^\s*DATE\s+DETAILS\s+REF\s*NO\.?\s+AMOUNT\s+BALANCE\s*$", re.IGNORECASE),
    # Footer line: support email + phone, often with "slice small finance bank".
    re.compile(r"need\s+help\?.*contact", re.IGNORECASE),
    re.compile(r"help@slice\.bank\.in", re.IGNORECASE),
    re.compile(r"slice\s+small\s+finance\s+bank", re.IGNORECASE),
    # Customer / account metadata lines (page 1 only).
    re.compile(r"^\s*customer\s+id\b", re.IGNORECASE),
    re.compile(r"^\s*account\s+savings\b", re.IGNORECASE),
    re.compile(r"^\s*phone\s+\d", re.IGNORECASE),
    re.compile(r"^\s*a/c\s*number\b", re.IGNORECASE),
    re.compile(r"^\s*email\s+\S+@", re.IGNORECASE),
    re.compile(r"^\s*nominee\b", re.IGNORECASE),
    re.compile(r"^\s*address\b", re.IGNORECASE),
    re.compile(r"^\s*branch\b", re.IGNORECASE),
    re.compile(r"^\s*account\s+opening\b", re.IGNORECASE),
    re.compile(r"^\s*ifsc\b", re.IGNORECASE),
    re.compile(r"^\s*alternate\s+ifsc\b", re.IGNORECASE),
    re.compile(r"^\s*micr\b", re.IGNORECASE),
    # Summary table rows (single-row header + values block on page 1).
    re.compile(r"^\s*opening\s+balance\b.*total\s+credits", re.IGNORECASE),
    re.compile(r"^\s*\+\s*\+\s*-\s*=\s*$"),
    # Generic page artefacts.
    re.compile(r"^\s*page\s+\d+\s+of\s+\d+\s*$", re.IGNORECASE),
    # End-of-document trailer printed below the final transaction
    # (e.g. "Generated on 16 May '26"). Without this filter the trailer
    # is mis-classified as a continuation of the last transaction's
    # description because no subsequent date-line terminates the block.
    re.compile(r"^\s*generated\s+on\b", re.IGNORECASE),
]


def normalize_text(text: str) -> str:
    """Apply Unicode-NFKC normalisation and unify common whitespace.

    PDFs frequently embed non-breaking spaces (U+00A0), zero-width
    joiners (U+200C/D), narrow no-break spaces (U+202F), etc. Without
    normalisation those characters survive into the parsed description
    and break downstream comparisons (e.g. dedupe by description).
    """
    if not text:
        return ""
    out = unicodedata.normalize("NFKC", text)
    # Replace exotic whitespace with a plain space, then collapse runs.
    out = re.sub(r"[\u00a0\u2007\u200b\u200c\u200d\u202f\u2060]", " ", out)
    out = re.sub(r"[ \t]+", " ", out)
    return out


def is_slice_noise(line: str) -> bool:
    """``True`` when the line is a Slice-statement header / footer / metadata."""
    if line is None:
        return True
    stripped = line.strip()
    if not stripped:
        return True
    for pat in SLICE_NOISE_PATTERNS:
        if pat.search(stripped):
            return True
    return False


# ---------------------------------------------------------------------------
# Canara Bank — noise patterns
# ---------------------------------------------------------------------------
#
# Canara statements interleave three kinds of non-transaction text with the
# real transaction blocks:
#
# 1. Per-page noise (every page) — the column header and the ``page N``
#    footer. These are reliably identical across pages and easy to drop.
# 2. Page-1 metadata block — customer info, IFSC, branch, address. Each
#    of these starts with a distinctive keyword (``Customer Id``,
#    ``Branch`` etc.) so we anchor on the first token.
# 3. Tail-of-statement boilerplate — the disclaimer block and ombudsman
#    contact info that follow the ``Closing Balance`` row. The parser
#    uses the literal ``Closing Balance`` marker as a hard stop, so the
#    tail patterns below are belt-and-braces in case the marker is ever
#    typeset differently.
#
# Detection is intentionally substring/anchor-based (not whole-line) so
# tiny PDF rendering variations (extra whitespace, line wrapping) do not
# leak boilerplate into transaction descriptions.

CANARA_NOISE_PATTERNS: List[re.Pattern[str]] = [
    # ---- per-page header / footer ----
    re.compile(r"^\s*date\s+particulars\s+deposits\s+withdrawals\s+balance\s*$",
               re.IGNORECASE),
    re.compile(r"^\s*page\s+\d+\s*$", re.IGNORECASE),
    # ---- page 1: account header strip ----
    re.compile(r"^\s*statement\s+for\s+a/c\b", re.IGNORECASE),
    re.compile(r"^\s*customer\s+id\b", re.IGNORECASE),
    re.compile(r"^\s*name\s+[A-Z]", re.IGNORECASE),
    re.compile(r"^\s*phone\s+\+?\d", re.IGNORECASE),
    re.compile(r"^\s*address\b", re.IGNORECASE),
    re.compile(r"^\s*joint\s+holder", re.IGNORECASE),
    re.compile(r"^\s*ifsc\s+code\b", re.IGNORECASE),
    re.compile(r"^\s*branch\s+(name|code)\b", re.IGNORECASE),
    re.compile(r"^\s*product\s+(code|name)\b", re.IGNORECASE),
    # Body-only address continuation lines (page 1) — these have no
    # keyword anchor, so we leave them to the buffer loop: any line
    # appearing BEFORE the Opening Balance marker is skipped by the
    # main parser, which is a simpler signal than trying to enumerate
    # every possible address fragment here.
    # ---- summary markers ----
    re.compile(r"^\s*opening\s+balance\b", re.IGNORECASE),
    re.compile(r"^\s*closing\s+balance\b", re.IGNORECASE),
    # ---- tail-of-statement boilerplate ----
    re.compile(r"^-+\s*end\s+of\s+statement\s*-+\s*$", re.IGNORECASE),
    re.compile(r"^\s*disclaimer\s*$", re.IGNORECASE),
    re.compile(r"^\s*computer\s+output", re.IGNORECASE),
    re.compile(r"^\s*beware\s+of\s+phishing", re.IGNORECASE),
    re.compile(r"^\s*details\s+of\s+ombudsman", re.IGNORECASE),
    re.compile(r"^\s*the\s+banking\s+ombudsman\b", re.IGNORECASE),
    re.compile(r"^\s*e[-\s]?mail\s*:", re.IGNORECASE),
    re.compile(r"\bcanara\s+bank\s+does\s+not\s+seek\b", re.IGNORECASE),
    re.compile(r"\bunless\s+the\s+constituent\b", re.IGNORECASE),
    re.compile(r"\bdo\s+not\s+share\s+atm\b", re.IGNORECASE),
    re.compile(r"\bdo\s+not\s+click\s+on\s+any\s+link\b", re.IGNORECASE),
    re.compile(r"\bchange\s+in\s+the\s+address\b", re.IGNORECASE),
    re.compile(r"\bphishing\s+attacks\b", re.IGNORECASE),
    re.compile(r"\bdigital\s+payment\b", re.IGNORECASE),
    re.compile(r"\bcanara\s+bank\b", re.IGNORECASE),
]


def is_canara_noise(line: str) -> bool:
    """``True`` when the line is Canara header / footer / boilerplate.

    NOTE: This deliberately does NOT match the page-1 customer-address
    continuation lines (e.g. ``S/O SHRI RAJENDRA RAJORIYA …``). Those
    are filtered out by the parser's "ignore everything before Opening
    Balance" rule, which is a simpler and more reliable signal than
    trying to regex every possible address fragment.
    """
    if line is None:
        return True
    stripped = line.strip()
    if not stripped:
        return True
    for pat in CANARA_NOISE_PATTERNS:
        if pat.search(stripped):
            return True
    return False


def split_clean_lines(raw_text: str) -> List[str]:
    """Split ``raw_text`` into normalised, non-empty lines.

    Empty lines and pure-whitespace lines are removed; the rest are
    Unicode-normalised and whitespace-collapsed. Noise filtering happens
    later — this helper does *not* drop noise so the caller can still see
    the full line stream for debugging.
    """
    if not raw_text:
        return []
    out: List[str] = []
    for raw in raw_text.split("\n"):
        cleaned = normalize_text(raw).strip()
        if cleaned:
            out.append(cleaned)
    return out
