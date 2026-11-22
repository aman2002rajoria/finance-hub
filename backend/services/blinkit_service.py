"""Ingest Blinkit invoice PDFs into the database."""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional, Set

from sqlalchemy import select
from sqlalchemy.orm import Session

from db.models import (
    BlinkitAnnexureChargeRecord,
    BlinkitOrder,
    BlinkitOrderItem,
    BlinkitParseErrorRecord,
    BlinkitScannedFileRecord,
)
from parsers.blinkit import BlinkitPDFParser
from parsers.blinkit.pdf_parser import DEFAULT_INVOICE_DIR
from parsers.blinkit.types import BlinkitInvoice, ScannedFile

logger = logging.getLogger(__name__)


@dataclass
class BlinkitIngestionResult:
    """Summary of a Blinkit scan/ingest run."""

    files_processed: int = 0
    orders_new: int = 0
    orders_skipped: int = 0
    items_new: int = 0
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


class BlinkitIngestionService:
    """Scan Blinkit_Orders folder and persist extracted orders."""

    def __init__(self, db: Session):
        self.db = db

    def scan_directory(
        self,
        directory: Optional[str] = None,
    ) -> BlinkitIngestionResult:
        """Parse all PDFs in the invoice folder and store new records."""
        dir_path = os.path.expanduser(directory or DEFAULT_INVOICE_DIR)
        result = BlinkitIngestionResult()

        if not os.path.isdir(dir_path):
            msg = f"Invoice directory not found: {dir_path}"
            logger.error(msg)
            result.errors.append(msg)
            return result

        existing_numbers = self._existing_invoice_numbers()
        logger.info(
            "Starting Blinkit scan of %s (%d order(s) already in DB)",
            dir_path, len(existing_numbers),
        )
        parse_result = BlinkitPDFParser(
            dir_path, skip_invoice_numbers=existing_numbers,
        ).parse()

        result.files_processed = parse_result.files_processed
        result.warnings = parse_result.warnings
        result.orders_skipped = parse_result.invoices_skipped

        # Record every file we touched even if every invoice on it turns
        # out to be a duplicate — this is what makes "files scanned" an
        # honest count instead of a proxy for "files with new data".
        self._record_scanned_files(parse_result.scanned_files)
        self.db.flush()

        for inv in parse_result.invoices:
            if inv.invoice_number and inv.invoice_number in existing_numbers:
                result.orders_skipped += 1
                continue
            # Each order is persisted inside its own SAVEPOINT so a failure
            # (e.g. a constraint violation on one bad row) only discards
            # that order — everything already staged earlier in this scan
            # stays intact instead of being wiped by a full rollback.
            try:
                with self.db.begin_nested():
                    self._persist_invoice(inv)
                result.orders_new += 1
                result.items_new += len(inv.items)
                if inv.invoice_number:
                    existing_numbers.add(inv.invoice_number)
            except Exception as exc:
                logger.warning("Failed to persist order %s: %s", inv.invoice_number, exc)
                self.db.add(BlinkitParseErrorRecord(
                    source_file=inv.source_file, page=inv.page_number, stage="persist",
                    reason=str(exc),
                ))
                result.errors.append(f"Failed to save order {inv.invoice_number}: {exc}")

        for err in parse_result.errors:
            self.db.add(BlinkitParseErrorRecord(
                source_file=err.source_file,
                page=err.page,
                stage=err.stage,
                reason=err.reason,
                snippet=err.snippet,
            ))
            result.errors.append(
                f"{err.source_file} p{err.page}: {err.reason}" if err.page
                else f"{err.source_file}: {err.reason}"
            )

        self.db.commit()
        if result.items_new > 0:
            self._auto_categorize()
        logger.info(
            "Blinkit scan complete: %d file(s), %d new order(s), %d skipped, "
            "%d new item(s), %d error(s)",
            result.files_processed, result.orders_new, result.orders_skipped,
            result.items_new, len(result.errors),
        )
        return result

    def ingest_pdf(self, file_path: str) -> BlinkitIngestionResult:
        """Parse and store a single PDF file."""
        result = BlinkitIngestionResult()
        existing_numbers = self._existing_invoice_numbers()

        parse_result = BlinkitPDFParser(
            file_path, skip_invoice_numbers=existing_numbers,
        ).parse()

        result.files_processed = parse_result.files_processed
        result.orders_skipped = parse_result.invoices_skipped

        self._record_scanned_files(parse_result.scanned_files)
        self.db.flush()

        for inv in parse_result.invoices:
            if inv.invoice_number and inv.invoice_number in existing_numbers:
                result.orders_skipped += 1
                continue
            try:
                with self.db.begin_nested():
                    self._persist_invoice(inv)
                result.orders_new += 1
                result.items_new += len(inv.items)
            except Exception as exc:
                logger.warning("Failed to persist order %s: %s", inv.invoice_number, exc)
                result.errors.append(str(exc))

        for err in parse_result.errors:
            self.db.add(BlinkitParseErrorRecord(
                source_file=err.source_file, page=err.page,
                stage=err.stage, reason=err.reason, snippet=err.snippet,
            ))
            result.errors.append(err.reason)

        self.db.commit()
        if result.items_new > 0:
            self._auto_categorize()
        return result

    def reprocess_all(self, directory: Optional[str] = None) -> BlinkitIngestionResult:
        """Wipe all Blinkit data and re-parse every PDF from scratch.

        Use this after a parser upgrade (new fields, bug fixes) so
        already-ingested orders pick up the improved extraction instead
        of being silently skipped as "duplicates" forever. The PDFs on
        disk are the durable source of truth — this operation is always
        safe to re-run.
        """
        logger.info("Reprocessing all Blinkit data — wiping existing tables")
        self.db.query(BlinkitOrderItem).delete()
        self.db.query(BlinkitAnnexureChargeRecord).delete()
        self.db.query(BlinkitOrder).delete()
        self.db.query(BlinkitParseErrorRecord).delete()
        self.db.query(BlinkitScannedFileRecord).delete()
        self.db.commit()
        return self.scan_directory(directory)

    # ------------------------------------------------------------------

    def _auto_categorize(self) -> None:
        """Backfill product categories after new items are ingested."""
        try:
            from services.blinkit_categorization_service import BlinkitCategorizationService
            cat = BlinkitCategorizationService(self.db).categorize_all(force=False)
            self.db.commit()
            logger.info(
                "Auto-categorized %d products (%d items updated)",
                cat.products_processed, cat.items_updated,
            )
        except Exception as exc:
            logger.warning("Auto-categorization failed: %s", exc)

    def _existing_invoice_numbers(self) -> Set[str]:
        rows = self.db.scalars(select(BlinkitOrder.invoice_number)).all()
        return set(rows)

    def _persist_invoice(self, inv: BlinkitInvoice) -> BlinkitOrder:
        record = BlinkitOrder(
            invoice_number=inv.invoice_number or inv.dedup_key,
            order_id=inv.order_id,
            invoice_date=inv.invoice_date,
            order_date=inv.order_date,
            delivery_date=inv.delivery_date,
            place_of_supply=inv.place_of_supply,
            order_status=inv.order_status,
            customer_name=inv.customer_name,
            customer_phone=inv.customer_phone,
            delivery_address=inv.delivery_address,
            delivery_city=inv.delivery_city,
            delivery_state=inv.delivery_state,
            delivery_pincode=inv.delivery_pincode,
            seller_name=inv.seller_name,
            seller_gstin=inv.seller_gstin,
            seller_fssai=inv.seller_fssai,
            seller_cin=inv.seller_cin,
            seller_pan=inv.seller_pan,
            store_name=inv.store_name,
            store_address=inv.store_address,
            store_city=inv.store_city,
            store_state=inv.store_state,
            store_pincode=inv.store_pincode,
            store_gstin=inv.store_gstin,
            platform_company=inv.platform_company,
            platform_gstin=inv.platform_gstin,
            platform_fssai=inv.platform_fssai,
            platform_cin=inv.platform_cin,
            platform_pan=inv.platform_pan,
            item_total=inv.item_total,
            delivery_fee=inv.delivery_fee,
            handling_charge=inv.handling_charge,
            convenience_fee=inv.convenience_fee,
            packaging_charge=inv.packaging_charge,
            other_charges=inv.other_charges,
            discount_total=inv.discount_total,
            coupon_discount=inv.coupon_discount,
            taxable_value_total=inv.taxable_value_total,
            cgst_total=inv.cgst_total,
            sgst_total=inv.sgst_total,
            igst_total=inv.igst_total,
            cess_total=inv.cess_total,
            tax_total=inv.tax_total,
            round_off=inv.round_off,
            grand_total=inv.grand_total,
            amount_paid=inv.amount_paid,
            total_quantity=inv.total_quantity,
            amount_in_words=inv.amount_in_words,
            payment_method=inv.payment_method,
            payment_transaction_id=inv.payment_transaction_id,
            reverse_charge=inv.reverse_charge,
            delivery_confirmation_otp=inv.delivery_confirmation_otp,
            terms_and_conditions=inv.terms_and_conditions,
            has_annexure=inv.has_annexure,
            is_continuation_merged=inv.is_continuation_merged,
            source_file=inv.source_file,
            source_file_hash=inv.source_file_hash,
            page_number=inv.page_number,
            pdf_metadata_json=json.dumps(inv.pdf_metadata) if inv.pdf_metadata else None,
            raw_text=inv.raw_text,
        )
        self.db.add(record)
        self.db.flush()

        for item in inv.items:
            self.db.add(BlinkitOrderItem(
                order_id=record.id,
                sr_no=item.sr_no,
                upc=item.upc,
                hsn_code=item.hsn_code,
                product_name=item.product_name,
                brand=item.brand,
                variant=item.variant,
                size_weight=item.size_weight,
                packaging=item.packaging,
                category=item.category,
                mrp=item.mrp,
                selling_price=item.selling_price,
                discount=item.discount,
                quantity=item.quantity,
                taxable_value=item.taxable_value,
                cgst_pct=item.cgst_pct,
                cgst_inr=item.cgst_inr,
                sgst_pct=item.sgst_pct,
                sgst_inr=item.sgst_inr,
                igst_pct=item.igst_pct,
                igst_inr=item.igst_inr,
                cess_pct=item.cess_pct,
                cess_inr=item.cess_inr,
                additional_cess_val=item.additional_cess_val,
                total_amount=item.total_amount,
                line_type=item.line_type,
                raw_description=item.raw_description,
            ))

        for charge in inv.annexure_charges:
            self.db.add(BlinkitAnnexureChargeRecord(
                order_id=record.id,
                sr_no=charge.sr_no,
                nature_of_charge=charge.nature_of_charge,
                tax_rate=charge.tax_rate,
                cess_rate=charge.cess_rate,
                taxable_value=charge.taxable_value,
                cgst=charge.cgst,
                sgst=charge.sgst,
                cess=charge.cess,
            ))

        return record

    def _record_scanned_files(self, files: List[ScannedFile]) -> None:
        """Upsert one row per PDF file touched during a scan/upload."""
        now = datetime.utcnow()
        for sf in files:
            existing = self.db.scalar(
                select(BlinkitScannedFileRecord).where(
                    BlinkitScannedFileRecord.file_hash == sf.file_hash,
                )
            )
            if existing:
                existing.filename = sf.filename
                existing.pages_found = sf.pages_found
                existing.orders_extracted = sf.orders_extracted
                existing.scan_count += 1
                existing.last_scanned_at = now
            else:
                self.db.add(BlinkitScannedFileRecord(
                    filename=sf.filename,
                    file_hash=sf.file_hash,
                    pages_found=sf.pages_found,
                    orders_extracted=sf.orders_extracted,
                    scan_count=1,
                    last_scanned_at=now,
                ))
