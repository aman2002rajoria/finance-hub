"""Structured datatypes for Blinkit invoice extraction (v2 schema)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, List, Optional

import pandas as pd

# Line-item classification — mirrors db.models.BLINKIT_LINE_* constants.
# Kept as plain strings here (not imported from db.models) so the parser
# package has zero dependency on the database layer.
LINE_PRODUCT = "product"
LINE_DELIVERY_CHARGE = "delivery_charge"
LINE_HANDLING_CHARGE = "handling_charge"
LINE_CONVENIENCE_CHARGE = "convenience_charge"
LINE_PACKAGING_CHARGE = "packaging_charge"
LINE_OTHER_CHARGE = "other_charge"

CHARGE_LINE_TYPES = {
    LINE_DELIVERY_CHARGE, LINE_HANDLING_CHARGE, LINE_CONVENIENCE_CHARGE,
    LINE_PACKAGING_CHARGE, LINE_OTHER_CHARGE,
}


@dataclass
class BlinkitInvoiceItem:
    """One line item from a Blinkit tax invoice."""

    sr_no: Optional[int] = None
    upc: Optional[str] = None
    hsn_code: Optional[str] = None
    product_name: str = ""
    brand: Optional[str] = None
    variant: Optional[str] = None
    size_weight: Optional[str] = None
    packaging: Optional[str] = None  # Pack, Tube, Bottle, etc.
    category: Optional[str] = None
    mrp: Optional[float] = None
    selling_price: Optional[float] = None
    discount: Optional[float] = None
    quantity: Optional[float] = None
    taxable_value: Optional[float] = None
    cgst_pct: Optional[float] = None
    cgst_inr: Optional[float] = None
    sgst_pct: Optional[float] = None
    sgst_inr: Optional[float] = None
    igst_pct: Optional[float] = None
    igst_inr: Optional[float] = None
    cess_pct: Optional[float] = None
    cess_inr: Optional[float] = None
    additional_cess_val: Optional[float] = None
    total_amount: Optional[float] = None
    line_type: str = LINE_PRODUCT
    raw_description: str = ""

    @property
    def is_charge(self) -> bool:
        return self.line_type in CHARGE_LINE_TYPES


@dataclass
class BlinkitAnnexureCharge:
    """Delivery / handling charge breakdown from the annexure table."""

    sr_no: Optional[int] = None
    nature_of_charge: str = ""
    tax_rate: Optional[float] = None
    cess_rate: Optional[float] = None
    taxable_value: Optional[float] = None
    cgst: Optional[float] = None
    sgst: Optional[float] = None
    cess: Optional[float] = None


@dataclass
class BlinkitInvoice:
    """One tax-invoice page extracted from a Blinkit PDF."""

    # Order / invoice identifiers
    order_id: Optional[str] = None
    invoice_number: Optional[str] = None
    invoice_date: Optional[date] = None
    order_date: Optional[date] = None
    delivery_date: Optional[date] = None
    place_of_supply: Optional[str] = None
    order_status: Optional[str] = None

    # Customer / delivery
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    delivery_address: Optional[str] = None
    delivery_city: Optional[str] = None
    delivery_state: Optional[str] = None
    delivery_pincode: Optional[str] = None

    # Seller / store
    seller_name: Optional[str] = None
    seller_gstin: Optional[str] = None
    seller_fssai: Optional[str] = None
    seller_cin: Optional[str] = None
    seller_pan: Optional[str] = None

    store_name: Optional[str] = None
    store_address: Optional[str] = None
    store_city: Optional[str] = None
    store_state: Optional[str] = None
    store_pincode: Optional[str] = None
    store_gstin: Optional[str] = None

    # Platform (Blink Commerce footer)
    platform_company: Optional[str] = None
    platform_gstin: Optional[str] = None
    platform_fssai: Optional[str] = None
    platform_cin: Optional[str] = None
    platform_pan: Optional[str] = None

    # Charges breakdown
    item_total: Optional[float] = None
    delivery_fee: Optional[float] = None
    handling_charge: Optional[float] = None
    convenience_fee: Optional[float] = None
    packaging_charge: Optional[float] = None
    other_charges: Optional[float] = None
    discount_total: Optional[float] = None
    coupon_discount: Optional[float] = None
    taxable_value_total: Optional[float] = None
    cgst_total: Optional[float] = None
    sgst_total: Optional[float] = None
    igst_total: Optional[float] = None
    cess_total: Optional[float] = None
    tax_total: Optional[float] = None
    round_off: Optional[float] = None
    grand_total: Optional[float] = None
    amount_paid: Optional[float] = None
    total_quantity: Optional[float] = None
    amount_in_words: Optional[str] = None

    # Payment (rarely present on these invoices — future-proofing)
    payment_method: Optional[str] = None
    payment_transaction_id: Optional[str] = None

    # Other metadata
    reverse_charge: Optional[str] = None
    delivery_confirmation_otp: Optional[str] = None
    terms_and_conditions: Optional[str] = None
    has_annexure: bool = False
    is_continuation_merged: bool = False

    # Provenance
    source_file: str = ""
    source_file_hash: Optional[str] = None
    page_number: int = 0
    pdf_metadata: Dict[str, Any] = field(default_factory=dict)
    raw_text: str = ""

    # Nested records
    items: List[BlinkitInvoiceItem] = field(default_factory=list)
    annexure_charges: List[BlinkitAnnexureCharge] = field(default_factory=list)

    @property
    def dedup_key(self) -> str:
        return self.invoice_number or f"{self.order_id}|p{self.page_number}"

    def recompute_charge_breakdown(self) -> None:
        """Derive per-charge-type totals from classified line items.

        Called after item classification so ``item_total``,
        ``delivery_fee``, ``handling_charge``, etc. reflect the actual
        rows on the page rather than requiring the caller to sum them.
        Only overwrites a field if it finds at least one matching row,
        so a page with no delivery-charge row leaves ``delivery_fee`` at
        whatever it was (usually ``None``).
        """
        sums: Dict[str, float] = {}
        counts: Dict[str, int] = {}
        for item in self.items:
            amt = item.total_amount or 0.0
            sums[item.line_type] = sums.get(item.line_type, 0.0) + amt
            counts[item.line_type] = counts.get(item.line_type, 0) + 1

        if counts.get(LINE_PRODUCT):
            self.item_total = round(sums.get(LINE_PRODUCT, 0.0), 2)
        if counts.get(LINE_DELIVERY_CHARGE):
            self.delivery_fee = round(sums.get(LINE_DELIVERY_CHARGE, 0.0), 2)
        if counts.get(LINE_HANDLING_CHARGE):
            self.handling_charge = round(sums.get(LINE_HANDLING_CHARGE, 0.0), 2)
        if counts.get(LINE_CONVENIENCE_CHARGE):
            self.convenience_fee = round(sums.get(LINE_CONVENIENCE_CHARGE, 0.0), 2)
        if counts.get(LINE_PACKAGING_CHARGE):
            self.packaging_charge = round(sums.get(LINE_PACKAGING_CHARGE, 0.0), 2)
        if counts.get(LINE_OTHER_CHARGE):
            self.other_charges = round(sums.get(LINE_OTHER_CHARGE, 0.0), 2)

        if self.items:
            disc = sum(i.discount or 0.0 for i in self.items)
            if disc:
                self.discount_total = round(disc, 2)
            self.taxable_value_total = round(
                sum(i.taxable_value or 0.0 for i in self.items), 2
            )
            self.cgst_total = round(sum(i.cgst_inr or 0.0 for i in self.items), 2)
            self.sgst_total = round(sum(i.sgst_inr or 0.0 for i in self.items), 2)
            self.igst_total = round(sum(i.igst_inr or 0.0 for i in self.items), 2)
            self.cess_total = round(
                sum((i.cess_inr or 0.0) + (i.additional_cess_val or 0.0) for i in self.items), 2
            )
            self.tax_total = round(
                (self.cgst_total or 0) + (self.sgst_total or 0) + (self.igst_total or 0), 2
            )


@dataclass
class ScannedFile:
    """A PDF file encountered during a scan run."""

    filename: str
    file_hash: str
    pages_found: int = 0
    orders_extracted: int = 0


@dataclass
class BlinkitParseError:
    """A single page/file that failed to parse."""

    source_file: str
    page: Optional[int] = None
    stage: str = "extract"
    reason: str = ""
    snippet: str = ""


@dataclass
class BlinkitParseResult:
    """Output of parsing one or more Blinkit PDFs."""

    invoices: List[BlinkitInvoice] = field(default_factory=list)
    errors: List[BlinkitParseError] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    scanned_files: List[ScannedFile] = field(default_factory=list)
    files_processed: int = 0
    files_skipped: int = 0
    invoices_skipped: int = 0

    def invoices_dataframe(self) -> pd.DataFrame:
        if not self.invoices:
            return pd.DataFrame()
        rows = []
        for inv in self.invoices:
            rows.append({
                "order_id": inv.order_id,
                "invoice_number": inv.invoice_number,
                "invoice_date": inv.invoice_date,
                "place_of_supply": inv.place_of_supply,
                "customer_name": inv.customer_name,
                "delivery_address": inv.delivery_address,
                "delivery_state": inv.delivery_state,
                "delivery_pincode": inv.delivery_pincode,
                "seller_name": inv.seller_name,
                "store_name": inv.store_name,
                "store_address": inv.store_address,
                "seller_gstin": inv.seller_gstin,
                "seller_fssai": inv.seller_fssai,
                "seller_cin": inv.seller_cin,
                "seller_pan": inv.seller_pan,
                "platform_company": inv.platform_company,
                "platform_gstin": inv.platform_gstin,
                "item_total": inv.item_total,
                "delivery_fee": inv.delivery_fee,
                "handling_charge": inv.handling_charge,
                "convenience_fee": inv.convenience_fee,
                "packaging_charge": inv.packaging_charge,
                "discount_total": inv.discount_total,
                "cgst_total": inv.cgst_total,
                "sgst_total": inv.sgst_total,
                "tax_total": inv.tax_total,
                "grand_total": inv.grand_total,
                "amount_in_words": inv.amount_in_words,
                "reverse_charge": inv.reverse_charge,
                "delivery_confirmation_otp": inv.delivery_confirmation_otp,
                "has_annexure": inv.has_annexure,
                "source_file": inv.source_file,
                "page_number": inv.page_number,
            })
        return pd.DataFrame(rows)

    def items_dataframe(self) -> pd.DataFrame:
        if not self.invoices:
            return pd.DataFrame()
        rows = []
        for inv in self.invoices:
            for item in inv.items:
                rows.append({
                    "order_id": inv.order_id,
                    "invoice_number": inv.invoice_number,
                    "invoice_date": inv.invoice_date,
                    "sr_no": item.sr_no,
                    "upc": item.upc,
                    "hsn_code": item.hsn_code,
                    "product_name": item.product_name,
                    "brand": item.brand,
                    "variant": item.variant,
                    "size_weight": item.size_weight,
                    "packaging": item.packaging,
                    "mrp": item.mrp,
                    "discount": item.discount,
                    "quantity": item.quantity,
                    "taxable_value": item.taxable_value,
                    "cgst_pct": item.cgst_pct,
                    "cgst_inr": item.cgst_inr,
                    "sgst_pct": item.sgst_pct,
                    "sgst_inr": item.sgst_inr,
                    "cess_pct": item.cess_pct,
                    "additional_cess_val": item.additional_cess_val,
                    "total_amount": item.total_amount,
                    "line_type": item.line_type,
                    "source_file": inv.source_file,
                })
        return pd.DataFrame(rows)
