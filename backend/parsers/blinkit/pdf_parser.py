"""Blinkit multi-page PDF parser with directory scanning.

Handles three kinds of pages per PDF:

1. A normal invoice page ("Sold By" + "Invoice To" + item table) → becomes
   one :class:`~parsers.blinkit.types.BlinkitInvoice`.
2. A **continuation / annexure-only** page — Blinkit occasionally spills
   the "Nature of charge" annexure table onto its own page with no
   invoice header at all. This must NOT become its own invoice (it has
   no invoice number, no order id); instead its charges are folded into
   the invoice that immediately preceded it in the same file.
3. A page that fails to parse entirely (corrupt/empty/unexpected layout)
   → logged as a :class:`~parsers.blinkit.types.BlinkitParseError` and
   skipped; the rest of the file (and the rest of the folder) keeps going.
"""

from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
from typing import List, Optional, Set

import pdfplumber

from parsers.blinkit.invoice_parser import BlinkitInvoicePageParser
from parsers.blinkit.types import (
    BlinkitInvoice,
    BlinkitParseError,
    BlinkitParseResult,
    ScannedFile,
)

logger = logging.getLogger(__name__)

DEFAULT_INVOICE_DIR = os.path.expanduser("~/Documents/Blinkit_Orders")


class BlinkitPDFParser:
    """Parse Blinkit order-invoice PDFs (one or many files / directories)."""

    def __init__(
        self,
        path: str | os.PathLike,
        *,
        skip_invoice_numbers: Optional[Set[str]] = None,
    ):
        self.path = Path(os.path.expanduser(str(path)))
        self.skip_invoice_numbers = skip_invoice_numbers or set()

    def parse(self) -> BlinkitParseResult:
        """Parse a single PDF file or all PDFs in a directory (recursive)."""
        result = BlinkitParseResult()

        if self.path.is_file():
            self._parse_file(self.path, result)
        elif self.path.is_dir():
            pdf_files = sorted(self.path.rglob("*.pdf"))
            logger.info("Found %d PDF file(s) in %s", len(pdf_files), self.path)
            for pdf in pdf_files:
                self._parse_file(pdf, result)
        else:
            msg = f"Path not found: {self.path}"
            logger.error(msg)
            result.errors.append(BlinkitParseError(source_file=str(self.path), reason=msg))

        logger.info(
            "Blinkit parse complete: %d file(s) processed, %d invoice(s) extracted, "
            "%d duplicate(s) skipped, %d error(s)",
            result.files_processed, len(result.invoices),
            result.invoices_skipped, len(result.errors),
        )
        return result

    @staticmethod
    def scan_directory(
        directory: Optional[str] = None,
        skip_invoice_numbers: Optional[Set[str]] = None,
    ) -> BlinkitParseResult:
        """Convenience: scan the default Blinkit_Orders folder."""
        dir_path = directory or DEFAULT_INVOICE_DIR
        parser = BlinkitPDFParser(dir_path, skip_invoice_numbers=skip_invoice_numbers)
        return parser.parse()

    # ------------------------------------------------------------------

    def _parse_file(self, pdf_path: Path, result: BlinkitParseResult) -> None:
        source_file = str(pdf_path)
        basename = os.path.basename(source_file)
        file_hash = _file_hash(pdf_path)
        orders_extracted = 0
        last_invoice: Optional[BlinkitInvoice] = None

        try:
            with pdfplumber.open(source_file) as pdf:
                metadata = dict(pdf.metadata or {})
                num_pages = len(pdf.pages)

                for page_num, page in enumerate(pdf.pages, start=1):
                    page_parser = BlinkitInvoicePageParser(page, page_num, basename)

                    try:
                        page_text = page.extract_text() or ""
                    except Exception as exc:
                        logger.warning(
                            "Could not extract text from p%d of %s: %s", page_num, basename, exc,
                        )
                        result.errors.append(BlinkitParseError(
                            source_file=basename, page=page_num, stage="extract",
                            reason=f"Text extraction failed: {exc}",
                        ))
                        continue

                    if not page_text.strip():
                        logger.warning("Skipping blank page p%d of %s", page_num, basename)
                        result.errors.append(BlinkitParseError(
                            source_file=basename, page=page_num, stage="extract",
                            reason="Page has no extractable text (scanned image?)",
                        ))
                        continue

                    if page_parser.is_continuation(page_text):
                        self._merge_continuation(
                            page_parser, last_invoice, basename, page_num, result,
                        )
                        continue

                    try:
                        invoice = page_parser.parse(pdf_metadata=metadata)
                        invoice.source_file_hash = file_hash
                    except Exception as exc:
                        logger.warning(
                            "Failed to parse invoice on p%d of %s: %s", page_num, basename, exc,
                        )
                        result.errors.append(BlinkitParseError(
                            source_file=basename, page=page_num, stage="extract",
                            reason=str(exc), snippet=page_text[:200],
                        ))
                        continue

                    last_invoice = invoice
                    orders_extracted += 1

                    if invoice.invoice_number and invoice.invoice_number in self.skip_invoice_numbers:
                        result.invoices_skipped += 1
                        logger.info(
                            "Skipping duplicate invoice %s (p%d of %s)",
                            invoice.invoice_number, page_num, basename,
                        )
                        continue

                    if not invoice.invoice_number:
                        logger.warning(
                            "Invoice on p%d of %s has no invoice_number — "
                            "will be deduped by order_id+page instead",
                            page_num, basename,
                        )

                    result.invoices.append(invoice)

                result.files_processed += 1
                result.scanned_files.append(ScannedFile(
                    filename=basename,
                    file_hash=file_hash,
                    pages_found=num_pages,
                    orders_extracted=orders_extracted,
                ))
                logger.info(
                    "Parsed %s: %d page(s) → %d order(s) extracted",
                    basename, num_pages, orders_extracted,
                )

        except Exception as exc:
            logger.error("Failed to open PDF %s: %s", basename, exc)
            result.errors.append(BlinkitParseError(
                source_file=basename, stage="extract", reason=str(exc),
            ))

    def _merge_continuation(
        self,
        page_parser: BlinkitInvoicePageParser,
        last_invoice: Optional[BlinkitInvoice],
        basename: str,
        page_num: int,
        result: BlinkitParseResult,
    ) -> None:
        """Fold an annexure-only continuation page into the preceding invoice."""
        if last_invoice is None:
            logger.warning(
                "Continuation page p%d of %s has no preceding invoice to attach to — "
                "skipping (charges lost)",
                page_num, basename,
            )
            result.errors.append(BlinkitParseError(
                source_file=basename, page=page_num, stage="extract",
                reason="Orphan continuation page with no preceding invoice",
            ))
            return

        try:
            extra_charges = page_parser.parse_continuation_annexure()
        except Exception as exc:
            logger.warning(
                "Failed to parse continuation annexure on p%d of %s: %s", page_num, basename, exc,
            )
            result.errors.append(BlinkitParseError(
                source_file=basename, page=page_num, stage="extract",
                reason=f"Continuation annexure parse failed: {exc}",
            ))
            return

        if extra_charges:
            last_invoice.annexure_charges.extend(extra_charges)
            last_invoice.has_annexure = True
            last_invoice.is_continuation_merged = True
            logger.info(
                "Merged %d annexure charge(s) from continuation p%d of %s into invoice %s",
                len(extra_charges), page_num, basename, last_invoice.invoice_number,
            )
        else:
            logger.warning(
                "Continuation page p%d of %s had no parseable annexure rows", page_num, basename,
            )


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()
