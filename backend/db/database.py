"""SQLAlchemy 2.0 engine + session factory.

Design notes
------------
* **One file** at ``data/finance.db`` (override with ``FINANCE_DB_PATH``).
* WAL journal mode for safe concurrent reads while writes happen.
* ``check_same_thread=False`` so the FastAPI worker can hand the same
  connection across coroutines.
* Foreign keys enforced (``linked_transaction_id``, ``original_transaction_id``).
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)

# Public demo (on Vercel, or FINANCE_PUBLIC_DEMO=1): only the made-up test data, kept in
# the temp folder because that is the only writable place on Vercel. It is rebuilt from
# scripts/seed_demo_data.py the first time the server starts.
PUBLIC_DEMO = bool(os.environ.get("VERCEL")) or os.environ.get("FINANCE_PUBLIC_DEMO") == "1"
if PUBLIC_DEMO:
    import tempfile
    os.environ["FINANCE_DEMO"] = "1"
    os.environ["FINANCE_DB_PATH"] = os.path.join(tempfile.gettempdir(), "finance-hub", "demo.db")

DB_PATH = os.environ.get(
    "FINANCE_DB_PATH",
    os.path.join(_BACKEND, "data", "finance.db"),
)
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)


# ---------------------------------------------------------------------------
# Engine + pragmas
# ---------------------------------------------------------------------------

engine: Engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
    future=True,
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragmas(dbapi_connection, _connection_record):
    """Run once per connection — enable FK + WAL on SQLite."""
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys = ON")
    cursor.execute("PRAGMA journal_mode = WAL")
    cursor.execute("PRAGMA synchronous = NORMAL")
    cursor.close()


SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
    expire_on_commit=False,
    future=True,
)


# ---------------------------------------------------------------------------
# Declarative base
# ---------------------------------------------------------------------------


class Base(DeclarativeBase):
    """Single declarative base for the whole project."""
    pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_schema_initialised = False


def init_db() -> None:
    """Create tables / indexes — safe to call repeatedly.

    Sets a module-level flag so the cheap fast-path check below can
    short-circuit subsequent calls.
    """
    global _schema_initialised
    # Import models so they register with Base.metadata before create_all.
    from db import models  # noqa: F401
    _drop_stale_blinkit_tables()
    Base.metadata.create_all(engine)

    # Run lightweight column-additive migrations BEFORE seeding the
    # taxonomy — the seed code reads columns that may be brand new.
    _migrate_schema()
    _seed_default_taxonomy()
    _ensure_refund_taxonomy()
    _seed_system_rules()
    _schema_initialised = True


# ---------------------------------------------------------------------------
# Lightweight in-place migrations
# ---------------------------------------------------------------------------
#
# SQLAlchemy's ``create_all`` only adds missing *tables*, not missing
# *columns*. For a personal SQLite app we don't want the operational
# overhead of Alembic, so we keep a tiny hand-rolled migration runner
# that adds columns one at a time when they're missing. Each migration
# is idempotent (gated on a PRAGMA-driven existence check), so booting
# the same DB twice is a no-op the second time around.


def _existing_columns(conn, table: str) -> set[str]:
    rows = conn.exec_driver_sql(f"PRAGMA table_info('{table}')").fetchall()
    return {r[1] for r in rows}


def _drop_stale_blinkit_tables() -> None:
    """Drop Blinkit tables with an incompatible (pre-v2) schema.

    Must run **before** ``create_all`` — that call only creates tables
    that don't exist yet, so a table left over from the old schema (with
    a renamed/removed column) would otherwise survive untouched and
    every insert against the current ORM model would fail with a
    column-mismatch error.

    Safe to run on every boot: it's a cheap ``PRAGMA table_info`` check
    that only fires the ``DROP TABLE`` when the old shape is detected.
    The Blinkit PDFs on disk (``~/Documents/Blinkit_Orders``) are the
    durable source of truth, so callers just re-scan after an upgrade.
    """
    try:
        with engine.begin() as conn:
            # v1 tables renamed outright — always stale if present.
            for old_table in ("blinkit_invoices", "blinkit_invoice_items"):
                conn.exec_driver_sql(f"DROP TABLE IF EXISTS {old_table}")

            # blinkit_annexure_charges kept its name but its FK column was
            # renamed invoice_id -> order_id; drop only if the old column
            # is still there (idempotent — no-op on an already-migrated DB).
            cols = _existing_columns(conn, "blinkit_annexure_charges")
            if cols and "invoice_id" in cols and "order_id" not in cols:
                conn.exec_driver_sql("DROP TABLE IF EXISTS blinkit_annexure_charges")
    except Exception:
        # Fresh DB (table doesn't exist yet) — nothing to drop.
        pass


def _migrate_schema() -> None:
    """Add new columns to existing DBs without dropping data."""
    with engine.begin() as conn:
        # Skip silently if the table doesn't even exist yet — fresh DB.
        try:
            txn_cols = _existing_columns(conn, "transactions")
        except Exception:
            txn_cols = set()

        # ---- transactions ------------------------------------------------
        if txn_cols:
            txn_additions: list[tuple[str, str]] = [
                ("sub_subcategory",         "ALTER TABLE transactions ADD COLUMN sub_subcategory VARCHAR"),
                ("is_refund",               "ALTER TABLE transactions ADD COLUMN is_refund BOOLEAN NOT NULL DEFAULT 0"),
                ("refund_category",         "ALTER TABLE transactions ADD COLUMN refund_category VARCHAR"),
                ("txn_time",                "ALTER TABLE transactions ADD COLUMN txn_time TIME"),
                ("categorization_source",   "ALTER TABLE transactions ADD COLUMN categorization_source VARCHAR"),
                ("categorized_by_rule_id",  "ALTER TABLE transactions ADD COLUMN categorized_by_rule_id INTEGER"),
            ]
            for col, ddl in txn_additions:
                if col not in txn_cols:
                    conn.exec_driver_sql(ddl)

        # ---- categorization_rules ---------------------------------------
        try:
            rule_cols = _existing_columns(conn, "categorization_rules")
        except Exception:
            rule_cols = set()
        if rule_cols:
            rule_additions: list[tuple[str, str]] = [
                ("sub_subcategory",  "ALTER TABLE categorization_rules ADD COLUMN sub_subcategory VARCHAR"),
                ("name",             "ALTER TABLE categorization_rules ADD COLUMN name VARCHAR"),
                ("description",      "ALTER TABLE categorization_rules ADD COLUMN description VARCHAR"),
                ("enabled",          "ALTER TABLE categorization_rules ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT 1"),
                ("is_system",        "ALTER TABLE categorization_rules ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT 0"),
                ("conditions_json",  "ALTER TABLE categorization_rules ADD COLUMN conditions_json TEXT"),
            ]
            for col, ddl in rule_additions:
                if col not in rule_cols:
                    conn.exec_driver_sql(ddl)

        # ---- blinkit_parse_errors ----------------------------------------
        try:
            err_cols = _existing_columns(conn, "blinkit_parse_errors")
        except Exception:
            err_cols = set()
        if err_cols and "stage" not in err_cols:
            conn.exec_driver_sql(
                "ALTER TABLE blinkit_parse_errors ADD COLUMN stage VARCHAR NOT NULL DEFAULT 'extract'"
            )

        # ---- blinkit_scanned_files ----------------------------------------
        try:
            sf_cols = _existing_columns(conn, "blinkit_scanned_files")
        except Exception:
            sf_cols = set()
        if sf_cols:
            sf_additions: list[tuple[str, str]] = [
                ("pages_found",      "ALTER TABLE blinkit_scanned_files ADD COLUMN pages_found INTEGER NOT NULL DEFAULT 0"),
                ("orders_extracted", "ALTER TABLE blinkit_scanned_files ADD COLUMN orders_extracted INTEGER NOT NULL DEFAULT 0"),
            ]
            for col, ddl in sf_additions:
                if col not in sf_cols:
                    conn.exec_driver_sql(ddl)

        # ---- blinkit_order_items / product_categories -------------------
        try:
            item_cols = _existing_columns(conn, "blinkit_order_items")
        except Exception:
            item_cols = set()
        if item_cols and "subcategory" not in item_cols:
            conn.exec_driver_sql(
                "ALTER TABLE blinkit_order_items ADD COLUMN subcategory VARCHAR"
            )

        try:
            cat_cols = _existing_columns(conn, "blinkit_product_categories")
        except Exception:
            cat_cols = set()
        if cat_cols and "subcategory" not in cat_cols:
            conn.exec_driver_sql(
                "ALTER TABLE blinkit_product_categories ADD COLUMN subcategory VARCHAR"
            )
        if cat_cols:
            cat_additions: list[tuple[str, str]] = [
                ("ai_categorized", "ALTER TABLE blinkit_product_categories ADD COLUMN ai_categorized BOOLEAN NOT NULL DEFAULT 0"),
                ("ai_model", "ALTER TABLE blinkit_product_categories ADD COLUMN ai_model VARCHAR"),
                ("ai_categorized_at", "ALTER TABLE blinkit_product_categories ADD COLUMN ai_categorized_at DATETIME"),
                ("prompt_version", "ALTER TABLE blinkit_product_categories ADD COLUMN prompt_version VARCHAR"),
                ("category_version", "ALTER TABLE blinkit_product_categories ADD COLUMN category_version VARCHAR"),
                ("confidence_score", "ALTER TABLE blinkit_product_categories ADD COLUMN confidence_score FLOAT"),
            ]
            for col, ddl in cat_additions:
                if col not in cat_cols:
                    conn.exec_driver_sql(ddl)
            # Backfill ai_categorized for existing LLM rows
            if cat_cols:
                conn.exec_driver_sql(
                    "UPDATE blinkit_product_categories SET ai_categorized = 1 WHERE source = 'llm'"
                )


def _seed_default_taxonomy() -> None:
    """Insert the mandatory category taxonomy on a fresh DB.

    Idempotent — if a category with the same (name, parent_id) already
    exists we don't touch it. This means a user who renames "Food" to
    "Eating Out" won't see "Food" reappear on next boot.
    """
    from db import models

    # Lazy import to keep the database module otherwise dependency-free.
    DEFAULT_TREE = {
        "expense": {
            "Food":              {"Dine-out": [], "Online Ordering": [], "Groceries": []},
            "Travel":            {
                "Daily Commute":        ["Rapido", "Uber", "Ola", "Auto", "Metro"],
                "Travel to Home":       ["Flight", "Train", "Bus", "Hotel"],
                "Travel to Girlfriend": [],
                "Other Travel":         [],
            },
            "Shopping":          {},
            "Electronics":       {"Laptop": [], "Phone": [], "Accessories": []},
            "Bills & Utilities": {},
            "Gifts":             {"Family": [], "Girlfriend": [], "Others": []},
            "Investments":       {"Mutual Funds": [], "Stocks": []},
            "Personal":          {},
            "Miscellaneous":     {},
        },
        "income": {
            "Salary":           {"Job": [], "Internship": []},
            "Interest Income":  {},
            "Dividends":        {},
            "Pocket Money":     {},
            "Scholarship":      {},
            "Other Income":     {},
        },
    }

    with SessionLocal() as session:
        # Skip if we've ever seeded — preserves user edits.
        existing_root = session.execute(
            # SQLAlchemy 2 style core query — cheap and avoids importing select() here.
            models.CategoryDefinition.__table__.select().where(
                models.CategoryDefinition.parent_id.is_(None),
            ).limit(1)
        ).first()
        if existing_root is not None:
            return

        order = 0
        for kind, roots in DEFAULT_TREE.items():
            for cat_name, subs in roots.items():
                order += 1
                cat = models.CategoryDefinition(
                    name=cat_name, level=1, parent_id=None,
                    kind=kind, sort_order=order,
                )
                session.add(cat)
                session.flush()
                sub_order = 0
                for sub_name, leaves in subs.items():
                    sub_order += 1
                    sub = models.CategoryDefinition(
                        name=sub_name, level=2, parent_id=cat.id,
                        kind=kind, sort_order=sub_order,
                    )
                    session.add(sub)
                    session.flush()
                    leaf_order = 0
                    for leaf_name in leaves:
                        leaf_order += 1
                        session.add(models.CategoryDefinition(
                            name=leaf_name, level=3, parent_id=sub.id,
                            kind=kind, sort_order=leaf_order,
                        ))
        session.commit()


def _ensure_refund_taxonomy() -> None:
    """Add Refunds & Recoveries income root on existing DBs (idempotent)."""
    from db import models

    REFUND_TREE = {
        "Refunds & Recoveries": [
            "Shared Expense Recovery",
            "Merchant Refund",
            "Reimbursement",
            "Other",
        ],
    }

    with SessionLocal() as session:
        for root_name, subs in REFUND_TREE.items():
            existing = session.scalar(
                select(models.CategoryDefinition).where(
                    models.CategoryDefinition.name == root_name,
                    models.CategoryDefinition.parent_id.is_(None),
                )
            )
            if existing:
                continue
            root = models.CategoryDefinition(
                name=root_name, level=1, parent_id=None,
                kind="income", sort_order=999,
            )
            session.add(root)
            session.flush()
            for i, sub_name in enumerate(subs, start=1):
                session.add(models.CategoryDefinition(
                    name=sub_name, level=2, parent_id=root.id,
                    kind="income", sort_order=i,
                ))
        session.commit()


def _seed_system_rules() -> None:
    """Insert / refresh built-in system rules (Rapido, …).

    Delegates to :mod:`services.rule_seeds` so the rule definitions live
    next to the rule engine code. Idempotent.
    """
    try:
        from services.rule_seeds import sync_system_rules
    except Exception:  # pragma: no cover — services importable in normal use
        return
    with SessionLocal() as session:
        try:
            sync_system_rules(session)
            session.commit()
        except Exception:
            session.rollback()
            raise


def _ensure_schema() -> None:
    """Self-heal: make sure the schema exists before the first session
    actually queries it. This is mostly for tests where the FastAPI
    lifespan hook may not have fired yet, but it costs nothing in
    production either."""
    if not _schema_initialised:
        init_db()


@contextmanager
def get_session() -> Iterator[Session]:
    """Standalone session context-manager for scripts and services."""
    _ensure_schema()
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def fastapi_session() -> Iterator[Session]:
    """Dependency for FastAPI routes — closes on response."""
    _ensure_schema()
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
