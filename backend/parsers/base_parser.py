"""Abstract base class for bank-statement parsers.

A parser is anything that turns a PDF file path into a list of
:class:`Transaction` records. Concrete implementations (e.g.
:class:`parser.sbi_parser.SBIParser`) override :meth:`parse_pdf` only; the
base class manages:

* The fail-safe driver loop (``parse()``).
* Conversion to a schema-correct :class:`pandas.DataFrame`.
* The error log (so the UI can show users which lines were skipped).

This module intentionally avoids any UI / Streamlit imports so the parser
can also be used as a library from scripts and notebooks.
"""

from __future__ import annotations

import logging
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Optional

import pandas as pd

from utils.excel_writer import COLUMNS, normalize_frame


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class Transaction:
    """A single, normalized transaction row.

    The string-typed fields are always non-None (empty string at worst);
    numeric fields default to 0.0 so the output DataFrame never has NaNs.

    Structured fields (``txn_mode`` etc.) are derived from
    ``description`` via :func:`utils.helpers.parse_description_structure`
    and are ``None`` when the corresponding component could not be
    confidently extracted from the source string. ``txn_raw_description``
    is the *un-structured* original text and is always populated — it's
    the canonical reference for downstream debugging.
    """

    date: pd.Timestamp
    description: str
    debit: float = 0.0
    credit: float = 0.0
    balance: float = 0.0
    source: str = "SBI"
    source_file: str = ""
    txn_mode: Optional[str] = None
    txn_reference: Optional[str] = None
    txn_vpa: Optional[str] = None
    txn_counterparty: Optional[str] = None
    txn_bank: Optional[str] = None
    txn_phone: Optional[str] = None
    txn_raw_description: str = ""


@dataclass
class ParseError:
    """A single skipped / failed line, kept for the error-log UI."""

    page: int
    line: str
    reason: str


@dataclass
class DebugRow:
    """Per-transaction parsing trace (mandatory per spec for diagnostics).

    Stores enough context for the UI / log to reconstruct *why* the parser
    made its decision: the raw joined line, the tokens it saw, and the
    final debit/credit/balance assignment with the rule that produced it.
    """

    page: int
    raw: str
    tokens: List[str]
    decision: str  # human-readable explanation of how amounts were assigned
    date: str = ""
    debit: float = 0.0
    credit: float = 0.0
    balance: float = 0.0


@dataclass
class ParseResult:
    """Everything a parser run produces.

    ``transactions`` is the happy path; ``errors`` is the list of skipped
    lines (so users can decide whether to investigate); ``warnings`` is
    free-form text aimed at the UI (e.g. "no transactions on page 3");
    ``debug`` holds a per-row trace of the parser's decisions.
    """

    transactions: List[Transaction] = field(default_factory=list)
    errors: List[ParseError] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    debug: List[DebugRow] = field(default_factory=list)
    pages_parsed: int = 0
    source_file: str = ""

    # ---------------- convenience ----------------

    def to_dataframe(self) -> pd.DataFrame:
        if not self.transactions:
            return pd.DataFrame(columns=COLUMNS)

        rows = [
            {
                "Date": t.date,
                "Description": t.description,
                "Debit": t.debit,
                "Credit": t.credit,
                "Balance": t.balance,
                "Source": t.source,
                "Source File": t.source_file,
                "txn_mode": t.txn_mode,
                "txn_reference": t.txn_reference,
                "txn_vpa": t.txn_vpa,
                "txn_counterparty": t.txn_counterparty,
                "txn_bank": t.txn_bank,
                "txn_phone": t.txn_phone,
                "txn_raw_description": t.txn_raw_description,
            }
            for t in self.transactions
        ]
        return normalize_frame(pd.DataFrame(rows))

    def errors_dataframe(self) -> pd.DataFrame:
        return pd.DataFrame(
            [{"Page": e.page, "Line": e.line, "Reason": e.reason} for e in self.errors]
        )

    def debug_dataframe(self) -> pd.DataFrame:
        return pd.DataFrame(
            [
                {
                    "Page": d.page,
                    "Date": d.date,
                    "Debit": d.debit,
                    "Credit": d.credit,
                    "Balance": d.balance,
                    "Decision": d.decision,
                    "Tokens": " | ".join(d.tokens),
                    "Raw": d.raw,
                }
                for d in self.debug
            ]
        )


# ---------------------------------------------------------------------------
# Abstract parser
# ---------------------------------------------------------------------------


class BaseParser(ABC):
    """Contract for a bank-specific parser.

    Concrete subclasses implement :meth:`parse_pdf`, which receives the file
    path and an optional PDF password, and *returns* a :class:`ParseResult`.
    The base class only provides convenience wrappers and the public
    :meth:`parse` entry-point that does fail-safe execution + logging.
    """

    BANK_NAME: str = "Unknown"

    def __init__(self, file_path: str, password: Optional[str] = None) -> None:
        self.file_path = file_path
        self.password = password or ""
        self.source_file = os.path.basename(file_path)

    # ------------------------------------------------------------------
    # Public driver
    # ------------------------------------------------------------------

    def parse(self) -> ParseResult:
        """Run the parser. Never raises on bad lines; raises only on hard
        errors (e.g. file not found, scanned/empty PDF, wrong password)."""
        if not os.path.exists(self.file_path):
            raise FileNotFoundError(self.file_path)

        result = self.parse_pdf()
        result.source_file = self.source_file
        # Make sure every transaction is tagged with the bank + filename.
        for txn in result.transactions:
            if not txn.source:
                txn.source = self.BANK_NAME
            if not txn.source_file:
                txn.source_file = self.source_file
        return result

    # ------------------------------------------------------------------
    # Subclass surface
    # ------------------------------------------------------------------

    @abstractmethod
    def parse_pdf(self) -> ParseResult:
        """Subclasses implement bank-specific extraction here."""
