"""Bank statement parsers."""

from parsers.base_parser import BaseParser, DebugRow, ParseError, ParseResult, Transaction
from parsers.bank_detector import (
    BANK_CANARA,
    BANK_SBI,
    BANK_SBI_CC,
    BANK_SLICE,
    BANK_SLICE_CC,
    BANK_SLICE_SAVINGS,
    detect_bank,
)
from parsers.canara_parser import CanaraParser
from parsers.sbi_cc_parser import SBICCParser
from parsers.sbi_parser import SBIParser
from parsers.slice_cc_parser import SliceCCParser
from parsers.slice_parser import SliceParser

__all__ = [
    "BaseParser",
    "DebugRow",
    "ParseError",
    "ParseResult",
    "Transaction",
    "SBIParser",
    "SBICCParser",
    "SliceParser",
    "SliceCCParser",
    "CanaraParser",
    "detect_bank",
    "BANK_SBI",
    "BANK_SBI_CC",
    "BANK_SLICE",
    "BANK_SLICE_SAVINGS",
    "BANK_SLICE_CC",
    "BANK_CANARA",
]
