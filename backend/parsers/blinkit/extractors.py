"""Regex and text helpers for Blinkit invoice field extraction.

Every extractor here is intentionally defensive: a failed match returns
``None`` (or an empty dict) rather than raising, so one missing field on
a slightly-different invoice layout never aborts extraction of the rest
of the page. Callers (``invoice_parser.py``) are responsible for logging
a warning when a field they expected turns out empty.
"""

from __future__ import annotations

import logging
import re
from datetime import date
from typing import List, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Date parsing
# ---------------------------------------------------------------------------

_DATE_PATTERNS = [
    (re.compile(r"(\d{1,2})[-/](\d{1,2})[-/](\d{4})"), "dmy"),          # 10-05-2026
    (re.compile(r"(\d{1,2})[-/](\w{3})[-/](\d{4})", re.I), "dby"),       # 10-May-2026
    (re.compile(r"(\d{1,2})\s+(\w{3,9})\s+(\d{4})", re.I), "dby_space"), # 10 May 2026
]

_MONTH_MAP = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def parse_invoice_date(raw: str) -> Optional[date]:
    """Parse Blinkit invoice dates in DD-MM-YYYY or DD-Mon-YYYY formats."""
    if not raw:
        return None
    raw = raw.strip()
    try:
        for pat, kind in _DATE_PATTERNS:
            m = pat.search(raw)
            if not m:
                continue
            if kind == "dmy":
                d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
                return date(y, mo, d)
            if kind in ("dby", "dby_space"):
                d = int(m.group(1))
                mo_str = m.group(2).lower()[:3]
                y = int(m.group(3))
                mo = _MONTH_MAP.get(mo_str)
                if mo:
                    return date(y, mo, d)
    except (ValueError, IndexError) as exc:
        logger.debug("Failed to parse date %r: %s", raw, exc)
    return None


def to_float(val: str | None) -> Optional[float]:
    if val is None:
        return None
    s = str(val).strip().replace(",", "")
    if not s or s in ("-", "—", "–", "None"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def to_int(val: str | None) -> Optional[int]:
    f = to_float(val)
    return int(f) if f is not None else None


def _clean_value(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip()).strip(" :")


# Blinkit prints the "Invoice To" block and the "Order Id / Invoice Date /
# Place of Supply" block as two side-by-side columns. pdfplumber's plain
# text extraction has no notion of columns, so it stitches both onto the
# same lines — e.g. "Name : Rohan Invoice : 18-May-2026" or an address line
# ending in "...Residency, Date" with "Place of : Karnataka" bleeding into
# the next line. These fragments always match one of a few fixed label
# patterns from the right-hand column, so we strip them back out of
# whatever left-column field we just captured.
_SIDECAR_LABEL_PATTERN = re.compile(
    r"\s*(?:"
    r"Invoice\s+Date\s*:\s*\d{1,2}[-/](?:[A-Za-z]{3,9}|\d{1,2})[-/]\d{4}"
    r"|Invoice\s*:\s*\d{1,2}[-/](?:[A-Za-z]{3,9}|\d{1,2})[-/]\d{4}"
    r"|Place\s+of\s+Supply\s*:?\s*[A-Za-z]*"
    r"|Place\s+of\s*:?\s*[A-Za-z]*"
    r"|\bDate\b"
    r"|\bSupply\b"
    r")\s*",
    re.IGNORECASE,
)


def _strip_sidecar_labels(s: Optional[str]) -> Optional[str]:
    if not s:
        return s
    cleaned = _SIDECAR_LABEL_PATTERN.sub(" ", s)
    cleaned = re.sub(r"\s*,\s*,\s*", ", ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,")
    # Collapse an immediately-repeated comma token (e.g. Blinkit sometimes
    # prints "...Bengaluru, Karnataka, , Karnataka, 560029" with the state
    # duplicated either side of a blank field).
    parts = [p.strip() for p in cleaned.split(",")]
    deduped = [p for i, p in enumerate(parts) if not (p and i > 0 and p == parts[i - 1])]
    cleaned = ", ".join(p for p in deduped if p)
    return cleaned or None


_INDIAN_STATES = (
    "Karnataka", "Delhi", "Maharashtra", "Haryana", "Uttar Pradesh",
    "Tamil Nadu", "West Bengal", "Telangana", "Gujarat", "Rajasthan",
    "Punjab", "Kerala", "Bihar", "Madhya Pradesh", "Odisha", "Andhra Pradesh",
)


def _guess_state_from_address(address: Optional[str]) -> Optional[str]:
    """Fallback when there's no explicit 'State :' label on this layout."""
    if not address:
        return None
    matches = [s for s in _INDIAN_STATES if re.search(rf"\b{s}\b", address, re.I)]
    return matches[-1] if matches else None


def _extract_simple(text: str, pattern: str) -> Optional[str]:
    try:
        m = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    except re.error as exc:  # pragma: no cover — defensive only
        logger.debug("Bad regex %r: %s", pattern, exc)
        return None
    if m:
        val = _clean_value(m.group(1))
        return val or None
    return None


# ---------------------------------------------------------------------------
# Product name parsing
# ---------------------------------------------------------------------------

_PACKAGING_SUFFIXES = re.compile(
    r"\((Pack|Tube|Bottle|Box|Jar|Pouch|Can|Sachet|Carton|Refill)\)",
    re.I,
)

_HSN_PATTERN = re.compile(r"\(HSN[-\s]?(\d+)\)", re.I)

_SIZE_PATTERN = re.compile(
    r"(\d+(?:\.\d+)?\s*(?:ml|l|g|kg|gm|mg|pcs|pc|pack|litre|ltr))\b",
    re.I,
)


def parse_product_description(raw: str) -> dict:
    """Split a Blinkit item description into structured parts.

    Never raises — a description that doesn't match any sub-pattern
    just yields ``brand``/``variant``/etc. as ``None`` and keeps the
    full raw string as ``product_name``.
    """
    if not raw:
        return {"product_name": "", "brand": None, "variant": None,
                "size_weight": None, "packaging": None, "hsn_code": None}

    raw = raw.strip()
    try:
        hsn_m = _HSN_PATTERN.search(raw)
        hsn = hsn_m.group(1) if hsn_m else None
        desc = _HSN_PATTERN.sub("", raw).strip()

        packaging = None
        pkg_m = _PACKAGING_SUFFIXES.search(desc)
        if pkg_m:
            packaging = pkg_m.group(1)
            desc = _PACKAGING_SUFFIXES.sub("", desc).strip()

        size_weight = None
        size_m = _SIZE_PATTERN.search(desc)
        if size_m:
            size_weight = size_m.group(1)
            desc = (desc[: size_m.start()] + desc[size_m.end():]).strip()
            desc = re.sub(r"\s+", " ", desc).strip()

        brand = None
        variant = None
        parts = desc.split()
        if parts:
            brand = parts[0]
            if len(parts) > 1:
                variant = " ".join(parts[1:])

        return {
            "product_name": raw,
            "brand": brand,
            "variant": variant,
            "size_weight": size_weight,
            "packaging": packaging,
            "hsn_code": hsn,
        }
    except Exception as exc:  # defensive — never let a weird string abort parsing
        logger.debug("Failed to parse product description %r: %s", raw, exc)
        return {"product_name": raw, "brand": None, "variant": None,
                "size_weight": None, "packaging": None, "hsn_code": None}


# ---------------------------------------------------------------------------
# Line-item classification (product vs platform fee)
# ---------------------------------------------------------------------------

# Order matters — more specific phrases first.
_CHARGE_KEYWORDS: List[tuple[str, str]] = [
    ("late night convenience", "convenience_charge"),
    ("convenience charge", "convenience_charge"),
    ("delivery and other charges", "delivery_charge"),
    ("delivery charge", "delivery_charge"),
    ("packaging charge", "packaging_charge"),
    ("packing charge", "packaging_charge"),
    ("handling charge", "handling_charge"),
    ("rain cess", "other_charge"),
    ("small cart charge", "other_charge"),
    ("surge charge", "other_charge"),
    ("tip", "other_charge"),
]


def classify_line_item(description: str) -> str:
    """Return one of the ``LINE_*`` constants for a raw item description."""
    if not description:
        return "product"
    desc_l = description.lower()
    for phrase, line_type in _CHARGE_KEYWORDS:
        if phrase in desc_l:
            return line_type
    return "product"


# ---------------------------------------------------------------------------
# Seller / store block parsing
# ---------------------------------------------------------------------------

def parse_seller_block(text: str) -> dict:
    """Extract seller/store details from the top of an invoice page."""
    result: dict = {}

    sold_by_m = re.search(
        r"Sold By(?:\s*/\s*Seller)?\s*\n(.+?)(?=\nInvoice To|\nGSTIN\s*:)",
        text, re.DOTALL | re.IGNORECASE,
    )
    if sold_by_m:
        block = sold_by_m.group(1).strip()
        lines = [ln.strip() for ln in block.split("\n") if ln.strip()]
        if lines:
            result["seller_name"] = lines[0]
        if len(lines) > 1:
            result["store_name"] = lines[1]
        if len(lines) > 2:
            addr_lines = lines[2:]
            result["store_address"] = ", ".join(addr_lines)
            pin_m = re.search(r"(?:Pin\s*Code|PIN)\s*:?\s*(\d{6})", block, re.I)
            if pin_m:
                result["store_pincode"] = pin_m.group(1)
            else:
                # fall back: last 6-digit number in the block
                pins = re.findall(r"\b(\d{6})\b", block)
                if pins:
                    result["store_pincode"] = pins[-1]
            city_m = re.search(r",\s*([A-Za-z][A-Za-z\s]+?),?\s*\d{6}", block)
            if city_m:
                result["store_city"] = city_m.group(1).strip()
            result["store_state"] = _guess_state_from_address(block)

    result["seller_gstin"] = _extract_simple(text, r"GSTIN\s*:?\s*([A-Z0-9]{15})")
    result["seller_fssai"] = _extract_simple(
        text, r"FSSAI\s*(?:License\s*)?(?:Number\s*)?:?\s*(\d+)"
    )
    result["seller_cin"] = _extract_simple(text, r"CIN\s*:?\s*([A-Z0-9]+)")
    result["seller_pan"] = _extract_simple(text, r"PAN\s*:?\s*([A-Z0-9]+)")
    # Store GSTIN is usually the same GSTIN block for third-party sellers;
    # for the Blink-Commerce-only logistics page it's the only GSTIN present.
    result["store_gstin"] = result["seller_gstin"]

    return result


def parse_customer_block(text: str) -> dict:
    """Extract customer / delivery details from the Invoice To section."""
    result: dict = {}

    inv_to_m = re.search(
        r"Invoice To\s*\n(.+?)(?=\nSr\.?\s*no|\nTotal\s|\Z)",
        text, re.DOTALL | re.IGNORECASE,
    )
    block = inv_to_m.group(1) if inv_to_m else text

    result["customer_name"] = _strip_sidecar_labels(
        _extract_simple(block, r"Name\s*:\s*(.+?)(?:\n|Address)")
    )
    result["delivery_address"] = _strip_sidecar_labels(
        _extract_simple(block, r"Address\s*:\s*(.+?)(?:\n(?:Pin\s*code|Pincode|State|Order))")
    )
    result["delivery_pincode"] = _extract_simple(
        block, r"(?:Pin\s*code|Pincode)\s*:\s*(\d{6})"
    )
    result["delivery_state"] = _extract_simple(block, r"State\s*:\s*(.+?)(?:\n|$)")
    if not result["delivery_state"]:
        result["delivery_state"] = _guess_state_from_address(result.get("delivery_address"))
    result["customer_phone"] = _extract_simple(
        text, r"(?:Phone|Mobile|Contact\s*No\.?)\s*:\s*(\+?\d[\d\s-]{7,14})"
    )

    # City: not printed as an explicit label on Blinkit invoices, but is
    # sometimes recoverable as the second-to-last comma-separated token
    # of the address (…, <City>, <State>, <PIN>).
    if result.get("delivery_address"):
        parts = [p.strip() for p in result["delivery_address"].split(",") if p.strip()]
        if len(parts) >= 2:
            candidate = parts[-1]
            if not re.match(r"^\d{6}$", candidate) and candidate.lower() not in (
                result.get("delivery_state", "") or ""
            ).lower():
                result["delivery_city"] = candidate

    result["order_id"] = _extract_simple(
        text, r"Order\s*(?:Id|ID)\s*:\s*([A-Z0-9]+)"
    )

    # Date appears in several layouts due to PDF text reflow:
    #   "Invoice Date : 10-05-2026"
    #   "Invoice : 10-May-2026"  (with "Date" wrapped to the next line)
    date_raw = _extract_simple(text, r"Invoice\s+Date\s*:\s*(.+?)(?:\n|Place)")
    if not date_raw:
        m = re.search(
            r"Invoice\s*:\s*(\d{1,2}[-/](?:\w{3}|\d{1,2})[-/]\d{4})",
            text, re.IGNORECASE,
        )
        date_raw = m.group(1) if m else None
    if date_raw:
        result["invoice_date"] = parse_invoice_date(date_raw)

    result["place_of_supply"] = _extract_simple(
        text, r"Place of(?:\s*\n\s*)?\s*Supply\s*:\s*(.+?)(?:\n|$)"
    )

    return result


def parse_invoice_number(text: str) -> Optional[str]:
    return _extract_simple(text, r"Invoice\s*Number\s*:?\s*([A-Z0-9]+)")


def parse_amount_in_words(text: str) -> Optional[str]:
    m = re.search(
        r"Amount in(?:\s*\n\s*)?\s*Words:?\s*(.+?)(?:\n(?:For\s+Blink|Blink Commerce|Authorised|Whether))",
        text, re.DOTALL | re.IGNORECASE,
    )
    if m:
        return re.sub(r"\s+", " ", m.group(1).strip())
    return None


def parse_platform_block(text: str) -> dict:
    """Extract Blink Commerce footer details."""
    result: dict = {}
    m = re.search(
        r"(Blink Commerce Private Limited[^\n]*(?:\n[^\n]*)?)",
        text, re.IGNORECASE,
    )
    if m:
        result["platform_company"] = m.group(1).strip()

    footer_m = re.search(
        r"Blink Commerce Private Limited.+?(?=Authorised Signatory|Whether the tax)",
        text, re.DOTALL | re.IGNORECASE,
    )
    footer = footer_m.group(0) if footer_m else text
    result["platform_gstin"] = _extract_simple(footer, r"GSTIN\s*([A-Z0-9]{15})")
    result["platform_fssai"] = _extract_simple(
        footer, r"FSSAI\s*(?:License\s*)?(?:Number\s*)?\s*(\d+)"
    )
    result["platform_cin"] = _extract_simple(footer, r"CIN\s*([A-Z0-9]+)")
    result["platform_pan"] = _extract_simple(footer, r"PAN\s*([A-Z0-9]+)")
    return result


def parse_terms(text: str) -> Optional[str]:
    m = re.search(
        r"Terms\s*&?\s*Conditions:?\s*(.+?)(?:\nAnnexure|\Z)",
        text, re.DOTALL | re.IGNORECASE,
    )
    if m:
        return m.group(1).strip()
    return None


def parse_reverse_charge(text: str) -> Optional[str]:
    m = re.search(
        r"Whether the tax is payable on reverse charge\s*[-–—]?\s*(.+?)(?:\n|$)",
        text, re.IGNORECASE,
    )
    return m.group(1).strip() if m else None


def parse_delivery_otp(text: str) -> Optional[str]:
    m = re.search(
        r"Delivery confirmation OTP:?\s*(.+?)(?:\n|$)",
        text, re.IGNORECASE,
    )
    if m:
        val = m.group(1).strip()
        return val if val else None
    return None


def parse_payment_info(text: str) -> dict:
    """Best-effort extraction of payment method / transaction reference.

    Blinkit tax invoices do not currently print payment details, so this
    almost always returns an empty dict — kept as its own function so
    the moment a layout *does* include them, only this needs updating.
    """
    result: dict = {}
    method_m = re.search(
        r"Payment\s*(?:Method|Mode)\s*:?\s*(UPI|Card|Wallet|Cash|COD|Net\s*Banking)",
        text, re.IGNORECASE,
    )
    if method_m:
        result["payment_method"] = method_m.group(1).strip()
    txn_m = re.search(
        r"(?:Transaction|Txn|UPI\s*Ref(?:erence)?)\s*(?:ID|No\.?)\s*:?\s*([A-Za-z0-9]+)",
        text, re.IGNORECASE,
    )
    if txn_m:
        result["payment_transaction_id"] = txn_m.group(1).strip()
    return result


def is_continuation_page(text: str) -> bool:
    """True if a page has no invoice header (annexure-only continuation).

    Blinkit occasionally spills an "Annexure" charges table onto its own
    page when the parent invoice's item table runs long. Such a page has
    no "Sold By" / "Invoice To" block and must NOT be treated as a new
    invoice — it belongs to whichever invoice preceded it in the PDF.
    """
    return "Sold By" not in text and "Invoice To" not in text
