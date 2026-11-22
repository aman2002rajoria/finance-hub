"""Persistent Excel storage for parsed transactions.

The output workbook always lives at::

    data/transactions.xlsx

with a single sheet named ``AllTransactions``. New parses are *appended* to
this sheet so the user accumulates a running ledger across uploads. The
writer is idempotent on schema (columns are always re-asserted) and is
tolerant of a missing / fresh file.

Why ``openpyxl`` specifically
-----------------------------
The spec mandates the openpyxl engine. We use it both to *append* (via a
load+write cycle with pandas) and to apply minimal post-write polish
(auto-width on columns, freeze header row) so the workbook is comfortable
to open by hand.
"""

from __future__ import annotations

import logging
import os
from typing import Iterable, List, Optional

import pandas as pd
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter


logger = logging.getLogger(__name__)


# Canonical column order used everywhere in the project. Anything that does
# not match this schema is dropped / coerced in :func:`_normalize_frame`.
# The first 7 columns are the core ledger; the trailing 5 hold the
# structured transaction decomposition produced by the parser.
COLUMNS: List[str] = [
    "Date",
    "Description",
    "Debit",
    "Credit",
    "Balance",
    "Source",
    "Source File",
    "txn_mode",
    "txn_reference",
    "txn_vpa",
    "txn_counterparty",
    "txn_bank",
    "txn_phone",
    "txn_raw_description",
]

# Columns that should be treated as free-form strings during normalisation.
STRING_COLUMNS: List[str] = [
    "Description",
    "Source",
    "Source File",
    "txn_mode",
    "txn_reference",
    "txn_vpa",
    "txn_counterparty",
    "txn_bank",
    "txn_phone",
    "txn_raw_description",
]


SHEET_NAME = "AllTransactions"


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ExcelLockedError(RuntimeError):
    """Raised when the target workbook is open in Excel / locked by another process."""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def normalize_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Force ``df`` into the canonical schema.

    Missing columns are created (with sensible defaults), extra columns are
    dropped, and numeric columns are coerced to ``float``. ``Date`` is
    coerced to ``pd.Timestamp`` via :func:`pd.to_datetime` (``dayfirst=True``).
    """
    if df is None or df.empty:
        return pd.DataFrame(columns=COLUMNS)

    out = df.copy()

    # Ensure every required column exists.
    for col in COLUMNS:
        if col not in out.columns:
            out[col] = None

    # Reorder + drop extras.
    out = out[COLUMNS]

    # Coerce types.
    out["Date"] = pd.to_datetime(out["Date"], errors="coerce", dayfirst=True)
    for col in ("Debit", "Credit", "Balance"):
        out[col] = pd.to_numeric(out[col], errors="coerce").fillna(0.0).astype(float)

    # Free-form string columns. ``None``/``NaN`` -> empty string so the
    # Excel output never shows a literal "nan" cell.
    for col in STRING_COLUMNS:
        out[col] = (
            out[col]
            .astype(object)
            .where(out[col].notna(), "")
            .astype(str)
        )

    # Source has a deterministic default if missing. Historically this was
    # hard-coded to "SBI" (when SBI was the only supported bank). Now that
    # we have multiple parsers the value is whatever each parser sets on
    # its Transaction objects (e.g. "Slice"); we only fall back to
    # "Unknown" when the parser produced nothing — which should never
    # happen in practice but keeps the column non-empty.
    out.loc[out["Source"] == "", "Source"] = "Unknown"

    return out.reset_index(drop=True)


def load_existing(path: str) -> pd.DataFrame:
    """Load the existing workbook into a DataFrame, or return an empty frame.

    Returns the canonical schema regardless of what is on disk.
    """
    if not os.path.exists(path):
        return pd.DataFrame(columns=COLUMNS)

    try:
        existing = pd.read_excel(path, sheet_name=SHEET_NAME, engine="openpyxl")
    except ValueError:
        # Sheet not found, but the file exists -> treat as fresh.
        logger.warning("Sheet '%s' not found in %s. Will recreate.", SHEET_NAME, path)
        return pd.DataFrame(columns=COLUMNS)
    except PermissionError as exc:
        raise ExcelLockedError(
            f"Cannot read {path}: it appears to be open in another program. "
            "Close it and try again."
        ) from exc

    return normalize_frame(existing)


def append_transactions(
    new_rows: pd.DataFrame,
    path: str = "data/transactions.xlsx",
    dedupe: bool = True,
) -> pd.DataFrame:
    """Append ``new_rows`` to the persistent workbook and return the full frame.

    Parameters
    ----------
    new_rows
        DataFrame with (at minimum) the canonical columns.
    path
        Destination workbook path (created if missing). Parent directories
        are created on demand.
    dedupe
        When True (the default), rows that exactly match an existing row on
        ``(Date, Description, Debit, Credit, Balance, Source File)`` are
        dropped before writing. This makes re-uploads of the same PDF safe.

    Returns
    -------
    The full, persisted DataFrame after the write completes.
    """
    new_rows = normalize_frame(new_rows)
    existing = load_existing(path)

    if existing.empty:
        combined = new_rows.copy()
    elif new_rows.empty:
        combined = existing.copy()
    else:
        combined = pd.concat([existing, new_rows], ignore_index=True)

    if dedupe and not combined.empty:
        combined = combined.drop_duplicates(
            subset=[
                "Date",
                "Description",
                "Debit",
                "Credit",
                "Balance",
                "Source File",
            ],
            keep="first",
        ).reset_index(drop=True)

    combined = combined.sort_values(
        by=["Source File", "Date"], kind="stable"
    ).reset_index(drop=True)

    _write_workbook(combined, path)
    return combined


def write_fresh(df: pd.DataFrame, path: str = "data/transactions.xlsx") -> pd.DataFrame:
    """Overwrite the workbook with ``df`` (no merge). Returns the persisted frame."""
    df = normalize_frame(df)
    _write_workbook(df, path)
    return df


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _write_workbook(df: pd.DataFrame, path: str) -> None:
    """Write ``df`` to ``path`` with light cosmetic polish.

    We always use ``openpyxl`` as required by the spec. The write is done in
    two steps: pandas writes the data, then we re-open the workbook to set
    column widths and freeze the header row.
    """
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)

    try:
        with pd.ExcelWriter(path, engine="openpyxl", mode="w") as writer:
            df.to_excel(writer, sheet_name=SHEET_NAME, index=False)
    except PermissionError as exc:
        raise ExcelLockedError(
            f"Cannot write to {path}. The file is probably open in Excel. "
            "Close it and retry."
        ) from exc

    # Cosmetic post-processing (best-effort, never fatal).
    try:
        wb = load_workbook(path)
        ws = wb[SHEET_NAME]
        ws.freeze_panes = "A2"
        _autosize_columns(ws, df)
        wb.save(path)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Cosmetic post-processing failed for %s: %s", path, exc)


def _autosize_columns(ws, df: pd.DataFrame) -> None:
    """Crude but effective auto-width based on string length of cell values."""
    for idx, col in enumerate(df.columns, start=1):
        series = df[col].astype(str)
        max_len = max([len(col)] + series.map(len).tolist()) if not series.empty else len(col)
        ws.column_dimensions[get_column_letter(idx)].width = min(max(max_len + 2, 12), 60)
