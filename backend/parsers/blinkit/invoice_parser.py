"""Parse a single Blinkit tax-invoice page.

Design notes
------------
Every extraction step is wrapped so a single missing/malformed field
never aborts the rest of the page: header fields fall back to ``None``
(see :mod:`parsers.blinkit.extractors`), and item-table parsing tries
table extraction first, then a text-based regex fallback if
``pdfplumber`` couldn't detect table boundaries (this happens on a
handful of the older 2025 layouts where cell borders don't render).
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional

import pdfplumber

from parsers.blinkit.extractors import (
    classify_line_item,
    is_continuation_page,
    parse_amount_in_words,
    parse_customer_block,
    parse_delivery_otp,
    parse_payment_info,
    parse_platform_block,
    parse_product_description,
    parse_reverse_charge,
    parse_seller_block,
    parse_terms,
    to_float,
    to_int,
)
from parsers.blinkit.extractors import parse_invoice_number as _parse_invoice_number
from parsers.blinkit.types import (
    LINE_PRODUCT,
    BlinkitAnnexureCharge,
    BlinkitInvoice,
    BlinkitInvoiceItem,
)

logger = logging.getLogger(__name__)

_ITEM_HEADER_MARKERS = ("sr. no", "item description", "mrp", "taxable value")


class BlinkitInvoicePageParser:
    """Extract one tax invoice from a single PDF page."""

    def __init__(self, page: pdfplumber.page.Page, page_number: int, source_file: str):
        self.page = page
        self.page_number = page_number
        self.source_file = source_file

    def is_continuation(self, text: Optional[str] = None) -> bool:
        """True if this page has no invoice header (pure annexure spillover)."""
        text = text if text is not None else (self.page.extract_text() or "")
        return is_continuation_page(text) and bool(text.strip())

    def parse_continuation_annexure(self) -> List[BlinkitAnnexureCharge]:
        """Extract just the annexure charges table from a continuation page."""
        tables = self.page.extract_tables() or []
        text = self.page.extract_text() or ""
        return self._parse_annexure(tables, text)

    def parse(self, pdf_metadata: Optional[Dict[str, Any]] = None) -> BlinkitInvoice:
        text = self.page.extract_text() or ""
        if not text.strip():
            raise ValueError("Empty page — no extractable text")

        inv = BlinkitInvoice(
            source_file=self.source_file,
            page_number=self.page_number,
            pdf_metadata=pdf_metadata or {},
            raw_text=text,
        )

        warnings: List[str] = []

        try:
            seller = parse_seller_block(text)
        except Exception as exc:
            logger.warning("Seller block parse failed on p%d of %s: %s", self.page_number, self.source_file, exc)
            seller, warnings = {}, warnings + ["seller_block_failed"]
        try:
            customer = parse_customer_block(text)
        except Exception as exc:
            logger.warning("Customer block parse failed on p%d of %s: %s", self.page_number, self.source_file, exc)
            customer = {}
        try:
            platform = parse_platform_block(text)
        except Exception as exc:
            logger.warning("Platform block parse failed on p%d of %s: %s", self.page_number, self.source_file, exc)
            platform = {}
        try:
            payment = parse_payment_info(text)
        except Exception:
            payment = {}

        inv.seller_name = seller.get("seller_name")
        inv.store_name = seller.get("store_name")
        inv.store_address = seller.get("store_address")
        inv.store_city = seller.get("store_city")
        inv.store_state = seller.get("store_state")
        inv.store_pincode = seller.get("store_pincode")
        inv.store_gstin = seller.get("store_gstin")
        inv.seller_gstin = seller.get("seller_gstin")
        inv.seller_fssai = seller.get("seller_fssai")
        inv.seller_cin = seller.get("seller_cin")
        inv.seller_pan = seller.get("seller_pan")

        inv.customer_name = customer.get("customer_name")
        inv.customer_phone = customer.get("customer_phone")
        inv.delivery_address = customer.get("delivery_address")
        inv.delivery_city = customer.get("delivery_city")
        inv.delivery_state = customer.get("delivery_state")
        inv.delivery_pincode = customer.get("delivery_pincode")
        inv.order_id = customer.get("order_id")
        inv.invoice_date = customer.get("invoice_date")
        inv.place_of_supply = customer.get("place_of_supply")

        inv.invoice_number = _parse_invoice_number(text)
        inv.amount_in_words = parse_amount_in_words(text)
        inv.reverse_charge = parse_reverse_charge(text)
        inv.delivery_confirmation_otp = parse_delivery_otp(text)
        inv.terms_and_conditions = parse_terms(text)
        inv.payment_method = payment.get("payment_method")
        inv.payment_transaction_id = payment.get("payment_transaction_id")

        inv.platform_company = platform.get("platform_company")
        inv.platform_gstin = platform.get("platform_gstin")
        inv.platform_fssai = platform.get("platform_fssai")
        inv.platform_cin = platform.get("platform_cin")
        inv.platform_pan = platform.get("platform_pan")

        # Items — try table extraction first, fall back to text
        try:
            tables = self.page.extract_tables() or []
        except Exception as exc:
            logger.warning("Table extraction failed on p%d of %s: %s", self.page_number, self.source_file, exc)
            tables = []

        try:
            inv.items = self._parse_items_from_tables(tables)
        except Exception as exc:
            logger.warning("Table-based item parse failed on p%d of %s: %s", self.page_number, self.source_file, exc)
            inv.items = []

        if not inv.items:
            try:
                inv.items = self._parse_items_from_text(text)
            except Exception as exc:
                logger.warning("Text-based item parse failed on p%d of %s: %s", self.page_number, self.source_file, exc)
                inv.items = []

        if not inv.items:
            logger.warning(
                "No line items extracted on p%d of %s (invoice %s) — check layout",
                self.page_number, self.source_file, inv.invoice_number,
            )

        try:
            inv.annexure_charges = self._parse_annexure(tables, text)
            inv.has_annexure = bool(inv.annexure_charges)
        except Exception as exc:
            logger.warning("Annexure parse failed on p%d of %s: %s", self.page_number, self.source_file, exc)

        # Totals + charges breakdown, derived from classified line items
        try:
            self._apply_totals(inv, text, tables)
        except Exception as exc:
            logger.warning("Totals extraction failed on p%d of %s: %s", self.page_number, self.source_file, exc)

        inv.recompute_charge_breakdown()

        # Missing critical identifiers are worth a loud warning even
        # though we don't abort — this is what lets us catch layout
        # drift early instead of silently losing invoices.
        if not inv.invoice_number:
            logger.warning(
                "Could not extract invoice_number on p%d of %s", self.page_number, self.source_file,
            )
        if not inv.order_id:
            logger.warning(
                "Could not extract order_id on p%d of %s (invoice %s)",
                self.page_number, self.source_file, inv.invoice_number,
            )

        return inv

    # ------------------------------------------------------------------
    # Item parsing
    # ------------------------------------------------------------------

    def _parse_items_from_tables(self, tables: List) -> List[BlinkitInvoiceItem]:
        items: List[BlinkitInvoiceItem] = []
        for table in tables:
            if not table or len(table) < 2:
                continue
            header_idx = self._find_header_row(table)
            if header_idx is None:
                continue

            header = [self._norm_cell(c) for c in table[header_idx]]
            col_map = self._map_columns(header)
            if "description" not in col_map:
                continue

            for row in table[header_idx + 1:]:
                if not row:
                    continue
                if self._is_total_row(row):
                    # Everything after the Total row in this table is
                    # footer/signature text pdfplumber merged into the
                    # same table (no visible border to separate them) —
                    # stop consuming rows here rather than picking it up
                    # as phantom "items".
                    break
                item = self._row_to_item(row, col_map)
                if item:
                    items.append(item)

        return items

    def _find_header_row(self, table: List) -> Optional[int]:
        for i, row in enumerate(table):
            joined = " ".join(self._norm_cell(c) for c in row if c).lower()
            if sum(m in joined for m in _ITEM_HEADER_MARKERS) >= 2:
                return i
        return None

    def _map_columns(self, header: List[str]) -> Dict[str, int]:
        col_map: Dict[str, int] = {}

        for i, h in enumerate(header):
            hl = h.lower()
            if "sr" in hl and "no" in hl:
                col_map["sr_no"] = i
            elif hl in ("upc",) or "upc" in hl:
                col_map["upc"] = i
            elif "hsn" in hl:
                col_map["hsn"] = i
            elif "item" in hl and "desc" in hl:
                col_map["description"] = i
            elif hl == "mrp":
                col_map["mrp"] = i
            elif "discount" in hl:
                col_map["discount"] = i
            elif "qty" in hl:
                col_map["qty"] = i
            elif "taxable" in hl:
                col_map["taxable"] = i
            elif "cgst" in hl and "%" in hl:
                col_map["cgst_pct"] = i
            elif "cgst" in hl and "inr" in hl:
                col_map["cgst_inr"] = i
            elif "sgst" in hl and "%" in hl:
                col_map["sgst_pct"] = i
            elif "sgst" in hl and "inr" in hl:
                col_map["sgst_inr"] = i
            elif "igst" in hl and "%" in hl:
                col_map["igst_pct"] = i
            elif "igst" in hl and "inr" in hl:
                col_map["igst_inr"] = i
            elif "cess" in hl and "%" in hl:
                col_map["cess_pct"] = i
            elif "additional" in hl and "cess" in hl:
                col_map["add_cess"] = i
            elif hl == "total":
                col_map["total"] = i

        # HSN-format invoices lack a UPC column — description sits right
        # after HSN.
        if "description" not in col_map and "hsn" in col_map:
            col_map["description"] = col_map["hsn"] + 1

        return col_map

    def _row_to_item(self, row: List, col_map: Dict[str, int]) -> Optional[BlinkitInvoiceItem]:
        def cell(key: str) -> str:
            idx = col_map.get(key)
            if idx is None or idx >= len(row):
                return ""
            return self._norm_cell(row[idx])

        desc = cell("description")
        desc_check = " ".join(self._norm_cell(c) for c in row if c)

        if not desc or desc.lower() in ("total", "-"):
            # Charge sub-rows (e.g. "Delivery and other charges") often
            # have an empty description cell but a populated charge label
            # elsewhere in the row.
            if "delivery" in desc_check.lower() or "handling" in desc_check.lower():
                desc = desc_check
            else:
                return None

        parsed = parse_product_description(desc)
        line_type = classify_line_item(desc)

        mrp = to_float(cell("mrp"))
        discount = to_float(cell("discount"))
        selling_price = None
        if mrp is not None:
            selling_price = round(mrp - (discount or 0.0), 2)

        return BlinkitInvoiceItem(
            sr_no=to_int(cell("sr_no")),
            upc=cell("upc") or None,
            hsn_code=cell("hsn") or parsed.get("hsn_code"),
            product_name=parsed.get("product_name", desc),
            brand=parsed.get("brand") if line_type == LINE_PRODUCT else None,
            variant=parsed.get("variant") if line_type == LINE_PRODUCT else None,
            size_weight=parsed.get("size_weight"),
            packaging=parsed.get("packaging"),
            mrp=mrp,
            selling_price=selling_price,
            discount=discount,
            quantity=to_float(cell("qty")),
            taxable_value=to_float(cell("taxable")),
            cgst_pct=to_float(cell("cgst_pct")),
            cgst_inr=to_float(cell("cgst_inr")),
            sgst_pct=to_float(cell("sgst_pct")),
            sgst_inr=to_float(cell("sgst_inr")),
            igst_pct=to_float(cell("igst_pct")),
            igst_inr=to_float(cell("igst_inr")),
            cess_pct=to_float(cell("cess_pct")),
            additional_cess_val=to_float(cell("add_cess")),
            total_amount=to_float(cell("total")),
            line_type=line_type,
            raw_description=desc,
        )

    def _parse_items_from_text(self, text: str) -> List[BlinkitInvoiceItem]:
        """Fallback: parse items from raw text when table extraction fails."""
        items: List[BlinkitInvoiceItem] = []

        start_m = re.search(
            r"Sr\.?\s*no\s+(?:UPC|HSN).+?Total\s*\n",
            text, re.IGNORECASE | re.DOTALL,
        )
        if not start_m:
            return items

        section = text[start_m.end():]
        end_m = re.search(r"\nTotal\s+", section)
        if end_m:
            section = section[: end_m.start()]

        row_pat = re.compile(
            r"^(\d+)\s+"
            r"([\d\-]+|998549|996819|996813)?\s*"
            r"(.+?)\s+"
            r"([\d.]+|-)\s+"
            r"([\d.]+|-)\s+"
            r"([\d.]+)\s+"
            r"([\d.]+)\s+"
            r"([\d.]+|-)\s+"
            r"([\d.]+|-)\s+"
            r"([\d.]+|-)\s+"
            r"([\d.]+|-)\s+"
            r"([\d.]+)",
            re.MULTILINE,
        )

        for m in row_pat.finditer(section):
            desc = m.group(3).strip()
            if desc.startswith("-"):
                continue
            parsed = parse_product_description(desc)
            line_type = classify_line_item(desc)
            mrp = to_float(m.group(4))
            discount = to_float(m.group(5))
            selling_price = round(mrp - (discount or 0.0), 2) if mrp is not None else None
            items.append(BlinkitInvoiceItem(
                sr_no=to_int(m.group(1)),
                upc=m.group(2) if m.group(2) and m.group(2) not in ("998549", "996819", "996813") else None,
                hsn_code=m.group(2) if m.group(2) in ("998549", "996819", "996813") else parsed.get("hsn_code"),
                product_name=parsed.get("product_name", desc),
                brand=parsed.get("brand") if line_type == LINE_PRODUCT else None,
                variant=parsed.get("variant") if line_type == LINE_PRODUCT else None,
                size_weight=parsed.get("size_weight"),
                packaging=parsed.get("packaging"),
                mrp=mrp,
                selling_price=selling_price,
                discount=discount,
                quantity=to_float(m.group(6)),
                taxable_value=to_float(m.group(7)),
                cgst_pct=to_float(m.group(8)),
                cgst_inr=to_float(m.group(9)),
                sgst_pct=to_float(m.group(10)),
                sgst_inr=to_float(m.group(11)),
                total_amount=to_float(m.group(12)),
                line_type=line_type,
                raw_description=desc,
            ))

        return items

    # ------------------------------------------------------------------
    # Annexure
    # ------------------------------------------------------------------

    def _parse_annexure(self, tables: List, text: str) -> List[BlinkitAnnexureCharge]:
        charges: List[BlinkitAnnexureCharge] = []

        for table in tables:
            if not table:
                continue
            header_idx = None
            for i, row in enumerate(table):
                joined = " ".join(self._norm_cell(c) for c in row if c).lower()
                if "nature of charge" in joined:
                    header_idx = i
                    break
            if header_idx is None:
                continue

            for row in table[header_idx + 1:]:
                if not row:
                    continue
                cells = [self._norm_cell(c) for c in row]
                if cells[0].lower() == "total":
                    break
                if not any(cells):
                    continue

                nature = cells[1] if len(cells) > 1 else ""
                if not nature or nature.lower() == "total":
                    continue

                charges.append(BlinkitAnnexureCharge(
                    sr_no=to_int(cells[0]),
                    nature_of_charge=nature,
                    tax_rate=to_float(cells[2]) if len(cells) > 2 else None,
                    cess_rate=to_float(cells[3]) if len(cells) > 3 else None,
                    taxable_value=to_float(cells[4]) if len(cells) > 4 else None,
                    cgst=to_float(cells[5]) if len(cells) > 5 else None,
                    sgst=to_float(cells[6]) if len(cells) > 6 else None,
                    cess=to_float(cells[7]) if len(cells) > 7 else None,
                ))

        return charges

    # ------------------------------------------------------------------
    # Totals
    # ------------------------------------------------------------------

    def _apply_totals(self, inv: BlinkitInvoice, text: str, tables: List) -> None:
        """Extract the totals row + grand total from the item table.

        The "Total" column is not always at the same cell index as the
        header — when trailing columns (e.g. Cess) are entirely blank on
        a given invoice, ``pdfplumber`` sometimes drops those cells from
        the Total row entirely, shifting everything left. Rather than
        trust the header-derived column index, we take the *rightmost*
        non-empty numeric cell in the Total row: Blinkit always prints
        the grand total as the last number on that row regardless of how
        many columns preceded it, which held true across every layout
        variant we've seen (3-column-shifted rows included).
        """
        best_total: Optional[float] = None
        best_qty: Optional[float] = None

        for table in tables:
            header_idx = self._find_header_row(table)
            if header_idx is None:
                continue

            header = [self._norm_cell(c) for c in table[header_idx]]
            col_map = self._map_columns(header)
            qty_col = col_map.get("qty")

            for row in table[header_idx + 1:]:
                if not self._is_total_row(row):
                    continue

                qty_val = (
                    to_float(self._norm_cell(row[qty_col]))
                    if qty_col is not None and qty_col < len(row)
                    else None
                )

                numeric_cells = [
                    (i, to_float(self._norm_cell(c)))
                    for i, c in enumerate(row)
                    if i != 0
                ]
                numeric_cells = [(i, v) for i, v in numeric_cells if v is not None]

                if numeric_cells:
                    # A genuinely free item (promo/sample) can have a real
                    # total of exactly 0 — only reject if we truly found
                    # nothing numeric on the row.
                    _, total_val = numeric_cells[-1]
                    best_total = total_val
                    best_qty = qty_val

        if best_total is not None:
            inv.grand_total = best_total
            inv.amount_paid = best_total
            inv.total_quantity = best_qty
            return

        m = re.search(r"\nTotal\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)", text)
        if m:
            inv.total_quantity = to_float(m.group(1))
            inv.grand_total = to_float(m.group(4))
            inv.amount_paid = inv.grand_total

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _norm_cell(val: Any) -> str:
        if val is None:
            return ""
        return re.sub(r"\s+", " ", str(val).strip())

    @staticmethod
    def _is_total_row(row: List) -> bool:
        for cell in row:
            if cell and str(cell).strip().lower() == "total":
                return True
        return False
