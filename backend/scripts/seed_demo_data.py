"""Build ``data/demo.db``: a fully synthetic dataset for public demos.

Nothing in here is read from or derived from the real ledger
(``data/finance.db``). Every row is generated from a fixed random seed,
so running the script twice produces the same database.

Run from ``backend/``::

    FINANCE_DB_PATH=data/demo.db .venv/bin/python scripts/seed_demo_data.py

Then point the API at it::

    FINANCE_DB_PATH=data/demo.db .venv/bin/python -m uvicorn main:app --port 8011

How the data goes in
--------------------
There are no PDFs, so instead of ``IngestionService.ingest_pdf_bytes`` we
build the same ``parsers.base_parser.Transaction`` objects the parsers
emit (descriptions shaped like each bank's statement text, structured
fields derived with each parser's own helpers) and push them through the
rest of the real ingestion pipeline: deterministic IDs, CC-payment
flagging, income / refund auto-tagging, saved-rule categorisation,
two-pass dedup insert, cross-account linking and the upload audit row.
After that the script performs the same actions a user would in the UI
(tag a few rows by hand, map card-bill payments to statements, convert
one purchase to EMI) through the same services the API routes call.

Blinkit orders are persisted through ``BlinkitIngestionService`` using
the parser's ``BlinkitInvoice`` dataclasses, then categorised with the
rule-based ``BlinkitCategorizationService`` (no LLM calls).
"""

from __future__ import annotations

import calendar
import hashlib
import os
import random
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Dict, List, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)


DEFAULT_DB_PATH = os.path.join(_BACKEND, "data", "demo.db")
_REAL_LEDGER = os.path.realpath(os.path.join(_BACKEND, "data", "finance.db"))
_LLM_ENV_KEYS = ("GEMINI_API_KEY", "GOOGLE_API_KEY")


class RefusedPath(ValueError):
    """Raised when asked to rebuild the real ledger."""


def resolve_db_path(raw: Optional[str] = None) -> str:
    """Absolute demo DB path. Relative values are taken against backend/.

    Raises :class:`RefusedPath` for anything named ``finance.db``.
    """
    raw = raw or os.environ.get("FINANCE_DB_PATH") or DEFAULT_DB_PATH
    path = os.path.realpath(raw if os.path.isabs(raw) else os.path.join(_BACKEND, raw))
    if os.path.basename(path).lower() == "finance.db" or path == _REAL_LEDGER:
        raise RefusedPath(
            f"Refusing to run: resolved DB path {path!r} is the real ledger. "
            "Use a demo file such as data/demo.db."
        )
    return path


# ``db.database`` binds its engine to FINANCE_DB_PATH at import time. When
# this file is the first thing to import ``db`` (script mode), point that
# at the demo DB first. When the backend imports this module, ``db`` is
# already bound and the environment is left alone; ``main()`` then either
# rebuilds the bound DB in place or re-runs itself in a subprocess.
if "db.database" not in sys.modules:
    try:
        os.environ["FINANCE_DB_PATH"] = resolve_db_path()
    except RefusedPath as _exc:
        if __name__ == "__main__":
            sys.exit(str(_exc))
        # Imported with the env pointing at the real ledger: bind the
        # module-level engine elsewhere; main() still refuses that path.
        os.environ["FINANCE_DB_PATH"] = DEFAULT_DB_PATH

if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

import pandas as pd  # noqa: E402
from sqlalchemy import func, select  # noqa: E402

from db import database as _database  # noqa: E402
from db.database import Base, SessionLocal, engine, init_db  # noqa: E402
from db.models import (  # noqa: E402
    ACCOUNT_TYPE_CREDIT_CARD, ACCOUNT_TYPE_SAVINGS, BlinkitOrder,
    BlinkitOrderItem, BlinkitProductCategoryRecord, CategoryDefinition,
    CCBillLink, EMIRecord, Transaction, Upload,
)
from parsers import (  # noqa: E402
    BANK_CANARA, BANK_SBI, BANK_SBI_CC, BANK_SLICE_CC, BANK_SLICE_SAVINGS,
)
from parsers import canara_parser, sbi_cc_parser, slice_cc_parser, slice_parser  # noqa: E402
from parsers.base_parser import Transaction as ParsedTxn  # noqa: E402
from parsers.blinkit.extractors import parse_product_description  # noqa: E402
from parsers.blinkit.types import (  # noqa: E402
    LINE_DELIVERY_CHARGE, LINE_HANDLING_CHARGE, LINE_OTHER_CHARGE, LINE_PRODUCT,
    BlinkitInvoice, BlinkitInvoiceItem, ScannedFile,
)
from services.blinkit_categorization_service import BlinkitCategorizationService  # noqa: E402
from services.blinkit_service import BlinkitIngestionService  # noqa: E402
from services.categorization_service import (  # noqa: E402
    CategorizationService, apply_income_autotag,
)
from services.category_taxonomy_service import CategoryTaxonomyService  # noqa: E402
from services.dedup_service import file_sha256  # noqa: E402
from services.emi_service import EMIService  # noqa: E402
from services.ingestion_service import BANK_REGISTRY, IngestionResult, IngestionService  # noqa: E402
from services.linking_service import LinkingService  # noqa: E402
from utils.helpers import VPA_REGEX, parse_description_structure  # noqa: E402


# ---------------------------------------------------------------------------
# Parameters
# ---------------------------------------------------------------------------

SEED = 20260601
START = date(2026, 6, 1)
END = date(2026, 11, 20)          # statements "downloaded" on 20 Nov 2026
MONTHS = [(2026, m) for m in range(6, 12)]

OWNER_UPPER = "ROHAN MEHTA"
OWNER_TITLE = "Rohan Mehta"
EMPLOYER = "KESTREL ANALYTICS PVT LTD"

SALARY = 85000.00
RENT = 24000.00
SIP_AMOUNT = 8000.00

OPENING = {"SBI": 148250.40, "CANARA": 41830.15, "SLICE": 6420.75}

rng = random.Random(SEED)


def money(lo: float, hi: float, paise: bool = True) -> float:
    v = rng.uniform(lo, hi)
    return round(v, 2) if paise else float(round(v))


def month_days(y: int, m: int) -> List[date]:
    last = calendar.monthrange(y, m)[1]
    return [d for d in (date(y, m, i) for i in range(1, last + 1)) if START <= d <= END]


def pick_days(y: int, m: int, n: int) -> List[date]:
    days = month_days(y, m)
    return sorted(rng.choice(days) for _ in range(n)) if days else []


def first_business_day(y: int, m: int, day: int = 1) -> date:
    d = date(y, m, day)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def in_range(d: date) -> bool:
    return START <= d <= END


_used_refs: set = set()


def upi_ref(d: date) -> str:
    """12-digit UPI RRN, unique across the dataset."""
    while True:
        ref = f"6{d:%y}{d.timetuple().tm_yday:03d}{rng.randint(100000, 999999)}"
        if ref not in _used_refs:
            _used_refs.add(ref)
            return ref


# ---------------------------------------------------------------------------
# Statement entries (one list per account, converted to ParsedTxn later)
# ---------------------------------------------------------------------------


@dataclass
class Entry:
    d: date
    description: str
    debit: float = 0.0
    credit: float = 0.0
    ref: Optional[str] = None           # Slice / Canara bank reference
    cc_section: Optional[str] = None    # Slice CC section label
    cc_merchant: Optional[str] = None   # Slice CC merchant line
    cc_method: Optional[str] = None     # Slice CC payment method
    tag: Optional[str] = None           # internal marker for post-insert actions
    seq: int = 0


_seq = 0
LEDGER: Dict[str, List[Entry]] = defaultdict(list)


def add(account: str, e: Entry) -> Entry:
    global _seq
    if not in_range(e.d):
        return e
    _seq += 1
    e.seq = _seq
    LEDGER[account].append(e)
    return e


# ---- description builders, one per bank's printed format -----------------

def sbi_upi(d, direction, name, bank, vpa, amount, tag=None):
    ref = upi_ref(d)
    desc = f"UPI/{direction}/{ref}/{name}/{bank}/{vpa}/UPI"
    if direction == "DR":
        return add("SBI", Entry(d, desc, debit=amount, tag=tag))
    return add("SBI", Entry(d, desc, credit=amount, tag=tag))


def canara_upi(d, direction, name, bank, vpa, amount, tag=None):
    ref = upi_ref(d)
    desc = f"UPI/{direction}/{ref}/{name}/{bank}/{vpa}/UPI"
    if direction == "DR":
        return add("CANARA", Entry(d, desc, debit=amount, ref=ref, tag=tag))
    return add("CANARA", Entry(d, desc, credit=amount, ref=ref, tag=tag))


def slice_upi(d, direction, name, vpa, amount, suffix="", tag=None):
    # Slice prints "UPI Debit-<name>-<vpa>"; the VPA lands on a wrapped
    # line, which the parser joins with a space.
    word = "Debit" if direction == "DR" else "Credit"
    desc = f"UPI {word}-{name}- {vpa}{suffix}"
    ref = f"{rng.randint(10**14, 10**15 - 1)}"
    if direction == "DR":
        return add("SLICE", Entry(d, desc, debit=amount, ref=ref, tag=tag))
    return add("SLICE", Entry(d, desc, credit=amount, ref=ref, tag=tag))


def sbi_cc(d, desc, amount, direction="D", tag=None):
    if direction == "D":
        return add("SBI_CC", Entry(d, desc, debit=amount, tag=tag))
    return add("SBI_CC", Entry(d, desc, credit=amount, tag=tag))


def slice_cc(d, merchant, amount, section="Spend", method="UPI", tag=None):
    desc = f"{merchant} ({method})" if method else merchant
    direction_debit = section not in ("Refund", "Cashback")
    e = Entry(d, desc, cc_section=section, cc_merchant=merchant, cc_method=method, tag=tag)
    if direction_debit:
        e.debit = amount
    else:
        e.credit = amount
    return add("SLICE_CC", e)


# ---------------------------------------------------------------------------
# Merchants / counterparties (all VPAs are synthetic)
# ---------------------------------------------------------------------------

VPA = {
    "swiggy": "swiggy@icici",
    "zomato": "zomato@hdfcbank",
    "blinkit": "blinkit.payu@axisbank",
    "zepto": "zepto.payu@hdfcbank",
    "rapido": "rapido.payu@axisbank",
    "uber": "uber.india@icici",
    "ola": "olacabs.payu@hdfcbank",
    "metro": "bmrcl.qr@sbi",
    "landlord": "sureshkumar.blr@okicici",
    "bescom": "bescom.billdesk@ybl",
    "act": "actfibernet.blr@hdfcbank",
    "airtel": "airtelpredirect@airtel",
    "mother": "sunita.mehta65@oksbi",
    "meghana": "meghanafoods@ybl",
    "more": "moreretail.blr@ybl",
    "owner_slice": "rohan.mehta@slc",
    "owner_sbi": "rohan.mehta@oksbi",
    "sbicard": "sbicard.billpay@sbi",
    "karthik": "karthik.rao@okicici",
    "ananya": "ananya.iyer@okhdfcbank",
}

# Small, untagged person-to-person / local-shop payees. These are what
# keep the Categorize page and "needs a tag" counters non-empty.
P2P_SBI = [
    ("LAKSHMI VEG STORE", "PYTM", "paytmqr2810050501abcd@paytm"),
    ("RAVI KUMAR", "SBIN", "ravikumar.k@upi"),
    ("SRI SAI CONDIMENTS", "YESB", "srisaicondiments@ybl"),
    ("PRIYA NAIR", "HDFC", "priya.nair92@upi"),
]
P2P_SLICE = [
    ("Deepak S", "deepak.s88@slc"),
    ("Nandini Milk Parlour", "nandiniparlour@ybl"),
    ("Sri Ganesh Tea Stall", "q000000001@ybl"),
    ("Imran Khan", "imran.k1990@upi"),
]


# ---------------------------------------------------------------------------
# Blinkit catalogue: (raw invoice description, MRP, GST %)
# Names chosen so the rule-based Blinkit taxonomy classifies them.
# ---------------------------------------------------------------------------

BLINKIT_CATALOGUE: List[Tuple[str, float, float]] = [
    ("Amul Taaza Toned Fresh Milk (500 ml) Pouch", 28.0, 0.0),
    ("Amul Masti Pouch Curd (400 g) Pouch", 35.0, 5.0),
    ("Milky Mist Fresh Paneer (200 g) Pack", 95.0, 5.0),
    ("Amul Pasteurised Butter (100 g) Pack", 60.0, 12.0),
    ("Robusta Banana (1 kg)", 55.0, 0.0),
    ("Onion (1 kg)", 42.0, 0.0),
    ("Hybrid Tomato (500 g)", 24.0, 0.0),
    ("Coriander Leaves (100 g)", 15.0, 0.0),
    ("Shimla Apple (4 pcs)", 149.0, 0.0),
    ("Farm Fresh White Eggs (6 pcs) Pack", 54.0, 0.0),
    ("Britannia 100% Whole Wheat Bread (400 g) Pack", 50.0, 0.0),
    ("Aashirvaad Shudh Chakki Atta (5 kg) Pack", 245.0, 5.0),
    ("India Gate Basmati Rice Feast Rozzana (1 kg) Pack", 115.0, 5.0),
    ("Tata Sampann Unpolished Toor Dal (1 kg) Pack", 189.0, 5.0),
    ("Fortune Sunflower Oil (1 l) Pouch", 165.0, 5.0),
    ("Everest Garam Masala (100 g) Pack", 82.0, 5.0),
    ("Lay's Classic Salted Chips (52 g) Pack", 20.0, 12.0),
    ("Haldiram's Aloo Bhujia (200 g) Pack", 55.0, 12.0),
    ("Cadbury Bournville Dark Chocolate (80 g) Pack", 110.0, 18.0),
    ("Coca-Cola Soft Drink (750 ml) Bottle", 40.0, 28.0),
    ("Paper Boat Aamras Juice (250 ml) Pack", 30.0, 12.0),
    ("Tata Tea Gold (250 g) Pack", 155.0, 5.0),
    ("Maggi 2-Minute Instant Noodles (280 g) Pack", 56.0, 12.0),
    ("Surf Excel Easy Wash Detergent Powder (1 kg) Pack", 140.0, 18.0),
    ("Vim Dishwash Bar (300 g) Pack", 30.0, 18.0),
    ("Lizol Floor Cleaner Citrus (975 ml) Bottle", 219.0, 18.0),
    ("Origami Kitchen Towel Roll (2 pcs) Pack", 120.0, 18.0),
    ("Colgate Strong Teeth Toothpaste (200 g) Tube", 112.0, 18.0),
    ("Dove Deeply Nourishing Body Wash (250 ml) Bottle", 299.0, 18.0),
    ("Himalaya Purifying Neem Face Wash (150 ml) Tube", 199.0, 18.0),
    ("Dolo 650 Tablet (15 pcs) Strip", 34.0, 12.0),
    ("Classmate Notebook Single Line (172 pages)", 65.0, 12.0),
    ("Wipro 9W LED Bulb (1 pc)", 99.0, 18.0),
    ("Duracell AA Battery (4 pcs) Pack", 180.0, 18.0),
]
STAPLE_IDX = list(range(0, 11))  # dairy / veg / eggs / bread show up most


# ---------------------------------------------------------------------------
# 1. Generate the ledgers
# ---------------------------------------------------------------------------


@dataclass
class BlinkitPlan:
    d: date
    invoice: BlinkitInvoice
    pay_via: str  # 'SLICE' or 'SLICE_CC'


def build_blinkit_orders() -> List[BlinkitPlan]:
    plans: List[BlinkitPlan] = []
    order_no = 0
    for (y, m) in MONTHS:
        n = 5 if m != 11 else 4
        for d in pick_days(y, m, n):
            order_no += 1
            items: List[BlinkitInvoiceItem] = []
            chosen = set(rng.sample(STAPLE_IDX, rng.randint(2, 4)))
            chosen |= set(rng.sample(range(len(BLINKIT_CATALOGUE)), rng.randint(1, 4)))
            sr = 0
            for idx in sorted(chosen):
                raw, mrp, gst = BLINKIT_CATALOGUE[idx]
                qty = float(rng.choice([1, 1, 1, 2]) if mrp < 120 else 1)
                disc_pct = rng.choice([0.0, 0.0, 0.05, 0.08, 0.12])
                sp = round(mrp * (1 - disc_pct), 2)
                total = round(sp * qty, 2)
                taxable = round(total / (1 + gst / 100.0), 2)
                half_tax = round((total - taxable) / 2.0, 2)
                parts = parse_product_description(raw)
                sr += 1
                items.append(BlinkitInvoiceItem(
                    sr_no=sr,
                    upc=f"890{1000000000 + idx * 7919:010d}",
                    hsn_code=parts.get("hsn_code"),
                    product_name=parts.get("product_name") or raw,
                    brand=parts.get("brand"),
                    variant=parts.get("variant"),
                    size_weight=parts.get("size_weight"),
                    packaging=parts.get("packaging"),
                    mrp=mrp,
                    selling_price=sp,
                    discount=round((mrp - sp) * qty, 2),
                    quantity=qty,
                    taxable_value=taxable,
                    cgst_pct=gst / 2.0, cgst_inr=half_tax,
                    sgst_pct=gst / 2.0, sgst_inr=half_tax,
                    igst_pct=0.0, igst_inr=0.0,
                    cess_pct=0.0, cess_inr=0.0,
                    total_amount=total,
                    line_type=LINE_PRODUCT,
                    raw_description=raw,
                ))
            item_total = sum(i.total_amount for i in items)

            def charge(name: str, amt: float, line_type: str) -> None:
                nonlocal sr
                sr += 1
                taxable = round(amt / 1.18, 2)
                half = round((amt - taxable) / 2.0, 2)
                items.append(BlinkitInvoiceItem(
                    sr_no=sr, product_name=name, quantity=1.0, mrp=amt,
                    selling_price=amt, taxable_value=taxable,
                    cgst_pct=9.0, cgst_inr=half, sgst_pct=9.0, sgst_inr=half,
                    total_amount=amt, line_type=line_type, raw_description=name,
                ))

            charge("Handling Charge", 11.0, LINE_HANDLING_CHARGE)
            if item_total < 199:
                charge("Delivery Charge", 30.0, LINE_DELIVERY_CHARGE)
            if item_total < 99:
                charge("Small Cart Fee", 20.0, LINE_OTHER_CHARGE)

            exact = round(sum(i.total_amount for i in items), 2)
            grand = float(round(exact))
            inv = BlinkitInvoice(
                order_id=f"{rng.randint(10**12, 10**13 - 1)}",
                invoice_number=f"KA26{order_no:02d}{rng.randint(10**7, 10**8 - 1)}",
                invoice_date=d, order_date=d, delivery_date=d,
                place_of_supply="Karnataka",
                order_status="Delivered",
                customer_name=OWNER_TITLE,
                customer_phone=None,
                delivery_address="Flat 302, Shanti Residency, 4th Cross, Koramangala 5th Block, Bengaluru 560095",
                delivery_city="Bengaluru",
                delivery_state="Karnataka",
                delivery_pincode="560095",
                seller_name=rng.choice([
                    "Koramangala Fresh Retail LLP",
                    "Anand Daily Needs Private Limited",
                ]),
                store_name=rng.choice(["Koramangala 5th Block Store", "HSR Layout Sector 2 Store"]),
                store_city="Bengaluru",
                store_state="Karnataka",
                store_pincode=rng.choice(["560095", "560102"]),
                platform_company="Blink Commerce Private Limited",
                round_off=round(grand - exact, 2),
                grand_total=grand,
                amount_paid=grand,
                source_file=f"blinkit_order_{inv_date_slug(d)}_{order_no:02d}.pdf",
                page_number=1,
                items=items,
            )
            inv.recompute_charge_breakdown()
            inv.total_quantity = sum(i.quantity or 0 for i in items if i.line_type == LINE_PRODUCT)
            inv.source_file_hash = hashlib.sha256(
                f"demo-blinkit|{inv.invoice_number}".encode()
            ).hexdigest()
            plans.append(BlinkitPlan(d=d, invoice=inv, pay_via=rng.choice(["SLICE", "SLICE", "SLICE_CC"])))
    return plans


def inv_date_slug(d: date) -> str:
    return d.strftime("%d%b%Y").lower()


def generate(blinkit: List[BlinkitPlan]) -> dict:
    """Populate LEDGER. Returns bookkeeping needed after insert."""
    plan: dict = {"transfers": 0}

    # ---------------- credit cards first (bills depend on them) ----------
    for (y, m) in MONTHS:
        # SBI Card
        for d in pick_days(y, m, rng.randint(1, 2)):
            sbi_cc(d, "AMAZON PAY INDIA PVT LTD BANGALORE IN", money(299, 1999))
        sbi_cc(pick_days(y, m, 1)[0], "AVENUE SUPERMARTS LTD BANGALORE IN", money(1150, 2400))
        sbi_cc(date(y, m, 5), "NETFLIX DI SI MUMBAI IN", 499.00)
        sbi_cc(date(y, m, 9), "SPOTIFY INDIA MUMBAI IN", 119.00)
        sbi_cc(pick_days(y, m, 1)[0], rng.choice(["BOOKMYSHOW MUMBAI IN", "PVR INOX LTD BANGALORE IN"]),
               money(320, 880))
        if rng.random() < 0.5:
            sbi_cc(pick_days(y, m, 1)[0], "TRUFFLES KORAMANGALA BANGALORE IN", money(780, 1650))
        if rng.random() < 0.5:
            sbi_cc(pick_days(y, m, 1)[0], "FLIPKART INTERNET PVT LTD BANGALORE IN", money(349, 1899))
        if rng.random() < 0.4:
            sbi_cc(pick_days(y, m, 1)[0], "APOLLO PHARMACY KORAMANGALA IN", money(180, 760))

        # Slice card (UPI on credit)
        for d in pick_days(y, m, rng.randint(2, 4)):
            slice_cc(d, "Swiggy", money(189, 640))
        for d in pick_days(y, m, rng.randint(1, 3)):
            slice_cc(d, "Zepto", money(140, 880))
        for d in pick_days(y, m, rng.randint(2, 4)):
            slice_cc(d, "Rapido", money(48, 165))
        for d in pick_days(y, m, rng.randint(1, 2)):
            slice_cc(d, "Uber", money(185, 470))
        if rng.random() < 0.5:
            slice_cc(pick_days(y, m, 1)[0], "Zomato", money(210, 690))

    # One-offs on SBI Card
    sbi_cc(date(2026, 7, 6), "MYNTRA DESIGNS PVT LTD BANGALORE IN", 2349.00)
    sbi_cc(date(2026, 10, 2), "MYNTRA DESIGNS PVT LTD BANGALORE IN", 3187.50)
    sbi_cc(date(2026, 7, 14), "AIR INDIA EXPRESS GURGAON IN", 5124.00)          # home trip
    sbi_cc(date(2026, 8, 7), "REDBUS IN BANGALORE IN", 1148.00)                   # weekend in Chennai
    sbi_cc(date(2026, 9, 18), "INDIGO 6E ONLINE GURGAON IN", 7842.00)             # Goa flights
    sbi_cc(date(2026, 9, 20), "MAKEMYTRIP INDIA GURGAON IN", 9640.00)             # Goa hotel
    sbi_cc(date(2026, 10, 11), "MARTINS CORNER BETALBATIM IN", 2340.00)           # dinner in Goa
    sbi_cc(date(2026, 10, 12), "BRITTOS RESTAURANT CALANGUTE IN", 1865.00)
    sbi_cc(date(2026, 8, 14), "FLIPKART INTERNET PVT LTD BANGALORE IN", 10999.00, tag="phone_emi")
    sbi_cc(date(2026, 9, 3), "AMAZON PAY INDIA PVT LTD BANGALORE IN", 1299.00)
    sbi_cc(date(2026, 9, 9), "AMAZON PAY INDIA PVT LTD REFUND BANGALORE IN", 1299.00,
           direction="C", tag="refund_amazon")
    sbi_cc(date(2026, 9, 24), "AMAZON PAY GIFT CARD BANGALORE IN", 2000.00, tag="gift_friend")

    # Blinkit orders paid on the Slice card
    for bp in blinkit:
        if bp.pay_via == "SLICE_CC":
            slice_cc(bp.d, "Blinkit", bp.invoice.grand_total)

    # ---------------- card bills ---------------------------------------
    def spend_for(account: str, y: int, m: int) -> float:
        return round(sum(
            e.debit for e in LEDGER[account] if e.d.year == y and e.d.month == m
        ), 2)

    for (y, m) in MONTHS[:-1]:
        ny, nm = (y, m + 1) if m < 12 else (y + 1, 1)
        # SBI Card statement paid from SBI savings around the 12th.
        amt = spend_for("SBI_CC", y, m)
        pay_day = date(ny, nm, 12)
        sbi_upi(pay_day, "DR", "SBI CARDS AND PAYMENT SER", "SBIN", VPA["sbicard"], amt,
                tag=f"ccbill:SBI_CC:{y:04d}-{m:02d}")
        recv = pay_day + timedelta(days=1)
        sbi_cc(recv, f"PAYMENT RECEIVED 000IR{rng.randint(10**9, 10**10 - 1)}", amt, direction="C")

        # Slice card repaid from Slice savings around the 5th.
        amt = spend_for("SLICE_CC", y, m)
        pay_day = date(ny, nm, 5)
        add("SLICE", Entry(pay_day, "Bill payment to slice credit card", debit=amt,
                           ref=f"{rng.randint(10**14, 10**15 - 1)}",
                           tag=f"ccbill:SLICE_CC:{y:04d}-{m:02d}"))
        slice_cc(pay_day, "Repayment", amt, section="Refund", method=None)

    # ---------------- SBI savings ---------------------------------------
    for (y, m) in MONTHS:
        mon = date(y, m, 1).strftime("%b %Y").upper()
        sal_day = first_business_day(y, m, 1)
        add("SBI", Entry(sal_day,
                         f"NEFT/CR/{upi_ref(sal_day)}/{EMPLOYER}/HDFC/SALARY {mon}",
                         credit=SALARY))
        sbi_upi(date(y, m, rng.randint(3, 5)), "DR", "SURESH KUMAR", "ICIC", VPA["landlord"], RENT)
        sip_day = date(y, m, 7)
        add("SBI", Entry(sip_day,
                         f"NACH/DR/{upi_ref(sip_day)}/ZERODHA BROKING LTD/HDFC/MF SIP",
                         debit=SIP_AMOUNT))
        sbi_upi(date(y, m, rng.randint(9, 12)), "DR", "BESCOM", "YESB", VPA["bescom"], money(760, 1340))
        sbi_upi(date(y, m, 15), "DR", "ATRIA CONVERGENCE", "HDFC", VPA["act"], 799.00)
        sbi_upi(date(y, m, rng.randint(18, 22)), "DR", "AIRTEL", "AIRP", VPA["airtel"], 349.00)

        # Self transfers: SBI -> Slice (twice) and SBI -> Canara.
        d = date(y, m, 2)
        amt = float(rng.choice([8000, 8500, 9000]))
        sbi_upi(d, "DR", OWNER_UPPER, "NESF", VPA["owner_slice"], amt)
        slice_upi(d + timedelta(days=rng.choice([0, 1])), "CR", OWNER_TITLE, VPA["owner_sbi"], amt)
        plan["transfers"] += 1
        d = date(y, m, rng.randint(15, 17))
        amt = float(rng.choice([2000, 2500, 3000]))
        sbi_upi(d, "DR", OWNER_UPPER, "NESF", VPA["owner_slice"], amt)
        slice_upi(d + timedelta(days=rng.choice([0, 1])), "CR", OWNER_TITLE, VPA["owner_sbi"], amt)
        plan["transfers"] += 1
        if m != 10:
            d = date(y, m, rng.randint(2, 4))
            ref = upi_ref(d)
            amt = float(rng.choice([4500, 5000, 6000]))
            add("SBI", Entry(d, f"IMPS/DR/{ref}/{OWNER_UPPER}/CNRB/SELF", debit=amt))
            cd = d + timedelta(days=rng.choice([0, 1, 2]))
            add("CANARA", Entry(cd, f"IMPS/CR/{ref}/{OWNER_UPPER}/SBIN/SELF", credit=amt, ref=ref))
            plan["transfers"] += 1

        # Day-to-day on SBI
        sbi_upi(pick_days(y, m, 1)[0], "DR", "MEGHANA FOODS", "YESB", VPA["meghana"], money(540, 1420))
        if rng.random() < 0.5:
            sbi_upi(pick_days(y, m, 1)[0], "DR", "ZOMATO LTD", "HDFC", VPA["zomato"], money(260, 720))
        for d in pick_days(y, m, rng.randint(1, 2)):
            name, bank, vpa = rng.choice(P2P_SBI)
            sbi_upi(d, "DR", name, bank, vpa, money(150, 900, paise=False))

    # Canara -> SBI in October (reverse direction transfer).
    d = date(2026, 10, 6)
    ref = upi_ref(d)
    add("CANARA", Entry(d, f"IMPS/DR/{ref}/{OWNER_UPPER}/SBIN/SELF", debit=4000.00, ref=ref))
    add("SBI", Entry(d + timedelta(days=1), f"IMPS/CR/{ref}/{OWNER_UPPER}/CNRB/SELF", credit=4000.00))
    plan["transfers"] += 1

    # SBI interest (quarterly) and other SBI one-offs.
    add("SBI", Entry(date(2026, 6, 30), "INTEREST CREDIT", credit=431.62))
    add("SBI", Entry(date(2026, 9, 30), "INTEREST CREDIT", credit=455.18))
    add("SBI", Entry(date(2026, 7, 25), "ATM WDL/ATM CASH 4471/KORAMANGALA BLR", debit=2000.00))
    add("SBI", Entry(date(2026, 10, 30), "ATM WDL/ATM CASH 4471/KORAMANGALA BLR", debit=3000.00))
    d = date(2026, 8, 19)
    add("SBI", Entry(d, f"NEFT/CR/{upi_ref(d)}/BRIGHTLEAF DESIGN STUDIO/ICIC/INVOICE BDS-014",
                     credit=8500.00))
    d = date(2026, 10, 27)
    add("SBI", Entry(d, f"NEFT/CR/{upi_ref(d)}/BRIGHTLEAF DESIGN STUDIO/ICIC/INVOICE BDS-019",
                     credit=6000.00))
    d = date(2026, 10, 23)
    add("SBI", Entry(d, f"NEFT/CR/{upi_ref(d)}/{EMPLOYER}/HDFC/SALARY BONUS H1 FY27",
                     credit=18000.00))
    # Retention bonus (an unusual up) and an iPad bought outright (a big down).
    d = date(2026, 10, 15)
    add("SBI", Entry(d, f"NEFT/CR/{upi_ref(d)}/{EMPLOYER}/HDFC/SALARY RETENTION BONUS FY27",
                     credit=200000.00))
    add("SBI", Entry(date(2026, 10, 18), "POS 4471XXXXXXXX2290 APPLE INDIA IMAGINE STORE BLR",
                     debit=99900.00))
    # A medical emergency in August (paid from the laptop savings).
    add("SBI", Entry(date(2026, 8, 22), "POS 4471XXXXXXXX2290 APOLLO HOSPITALS BANNERGHATTA BLR",
                     debit=30000.00))
    # Shared-expense recoveries (friends paying back their share).
    sbi_upi(date(2026, 8, 24), "CR", "KARTHIK RAO", "ICIC", VPA["karthik"], 1243.50, tag="recovery_food")
    sbi_upi(date(2026, 10, 16), "CR", "ANANYA IYER", "HDFC", VPA["ananya"], 3213.33, tag="recovery_travel")

    # ---------------- Canara savings -----------------------------------
    for (y, m) in MONTHS:
        canara_upi(date(y, m, rng.randint(4, 6)), "DR", "SUNITA MEHTA", "SBIN", VPA["mother"], 2500.00)
        for d in pick_days(y, m, rng.randint(1, 2)):
            canara_upi(d, "DR", "MORE RETAIL", "YESB", VPA["more"], money(420, 1380))
    add("CANARA", Entry(date(2026, 6, 30), "SB Interest Paid till 30-06-2026", credit=268.40,
                        ref="0"))
    add("CANARA", Entry(date(2026, 9, 30), "SB Interest Paid till 30-09-2026", credit=301.75,
                        ref="0"))

    # ---------------- Slice savings ------------------------------------
    for (y, m) in MONTHS:
        for d in pick_days(y, m, rng.randint(3, 5)):
            slice_upi(d, "DR", "Swiggy Limited", VPA["swiggy"], money(165, 610))
        for d in pick_days(y, m, rng.randint(1, 2)):
            slice_upi(d, "DR", "Zomato Ltd", VPA["zomato"], money(220, 640))
        for d in pick_days(y, m, rng.randint(1, 2)):
            slice_upi(d, "DR", "Zepto", VPA["zepto"], money(120, 760))
        for d in pick_days(y, m, rng.randint(5, 8)):
            slice_upi(d, "DR", "Rapido", VPA["rapido"], money(45, 155))
        for d in pick_days(y, m, rng.randint(4, 7)):
            slice_upi(d, "DR", "BMRCL", VPA["metro"], float(rng.choice([30, 35, 42, 48, 55])))
        if rng.random() < 0.7:
            slice_upi(pick_days(y, m, 1)[0], "DR", "Ola", VPA["ola"], money(160, 420))
        for d in pick_days(y, m, rng.randint(1, 3)):
            name, vpa = rng.choice(P2P_SLICE)
            slice_upi(d, "DR", name, vpa, float(rng.choice([60, 80, 120, 150, 200, 250])))
        last = month_days(y, m)[-1]
        if last == date(y, m, calendar.monthrange(y, m)[1]):
            add("SLICE", Entry(last, f"Interest Cr. for {last:%d-%b-%Y}",
                               credit=money(14, 38), ref=f"{rng.randint(10**13, 10**14 - 1)}"))
    slice_upi(date(2026, 8, 11), "CR", "Zomato Ltd", VPA["zomato"], 412.00,
              suffix=" Refund for cancelled order", tag="refund_zomato")

    for bp in blinkit:
        if bp.pay_via == "SLICE":
            slice_upi(bp.d, "DR", "Blinkit", VPA["blinkit"], bp.invoice.grand_total)

    return plan


# ---------------------------------------------------------------------------
# 2. Entries -> parser Transaction objects (each bank's own field logic)
# ---------------------------------------------------------------------------

ACCOUNT_BANK = {
    "SBI": BANK_SBI,
    "CANARA": BANK_CANARA,
    "SLICE": BANK_SLICE_SAVINGS,
    "SBI_CC": BANK_SBI_CC,
    "SLICE_CC": BANK_SLICE_CC,
}

STATEMENT_FILES = {
    "SBI": "SBI_Account_Statement_01Jun26_20Nov26.pdf",
    "CANARA": "Canara_Bank_Statement_Jun-Nov_2026.pdf",
    "SLICE": "slice_statement_01Jun26_20Nov26.pdf",
    "SBI_CC": "SBI_Card_Statements_Jun-Nov_2026.pdf",
    "SLICE_CC": "slice_Credit_Card_Statements_Jun-Nov_2026.pdf",
}


def to_parsed(account: str, entries: List[Entry]) -> List[ParsedTxn]:
    entries = sorted(entries, key=lambda e: (e.d, e.seq))
    src = STATEMENT_FILES[account]
    out: List[ParsedTxn] = []
    bal = OPENING.get(account, 0.0)
    for e in entries:
        ts = pd.Timestamp(e.d)
        if account in OPENING:
            bal = round(bal + e.credit - e.debit, 2)
        if account == "SBI":
            s = parse_description_structure(e.description)
            out.append(ParsedTxn(
                date=ts, description=e.description, debit=e.debit, credit=e.credit,
                balance=bal, source="SBI", source_file=src,
                txn_mode=s["txn_mode"], txn_reference=s["txn_reference"],
                txn_vpa=s["txn_vpa"], txn_counterparty=s["txn_counterparty"],
                txn_bank=s["txn_bank"], txn_phone=s["txn_phone"],
                txn_raw_description=s["txn_raw_description"],
            ))
        elif account == "CANARA":
            vpa = VPA_REGEX.search(e.description)
            out.append(ParsedTxn(
                date=ts, description=e.description, debit=e.debit, credit=e.credit,
                balance=bal, source="Canara", source_file=src,
                txn_mode=canara_parser._categorise(e.description),
                txn_reference=e.ref or canara_parser._hash_reference(
                    e.d.isoformat(), e.description, e.debit or e.credit),
                txn_vpa=vpa.group(0) if vpa else None,
                txn_counterparty=canara_parser._extract_counterparty(e.description),
                txn_raw_description=e.description,
            ))
        elif account == "SLICE":
            s = slice_parser._structured_fields(e.description)
            out.append(ParsedTxn(
                date=ts, description=e.description, debit=e.debit, credit=e.credit,
                balance=bal, source="Slice", source_file=src,
                txn_mode=s["txn_mode"], txn_reference=e.ref,
                txn_vpa=s["txn_vpa"], txn_counterparty=s["txn_counterparty"],
                txn_bank=s["txn_bank"], txn_phone=s["txn_phone"],
                txn_raw_description=s["txn_raw_description"],
            ))
        elif account == "SBI_CC":
            amt = e.debit or e.credit
            direction = "D" if e.debit else "C"
            out.append(ParsedTxn(
                date=ts, description=e.description, debit=e.debit, credit=e.credit,
                balance=0.0, source="SBI-CC", source_file=src,
                txn_mode=sbi_cc_parser._categorise(e.description),
                txn_reference=sbi_cc_parser._extract_reference(e.description, e.d.isoformat(), amt),
                txn_raw_description=f"{e.d:%d %b %y} {e.description} {amt:,.2f} {direction}",
            ))
        elif account == "SLICE_CC":
            amt = e.debit or e.credit
            mode = f"CC-{e.cc_section}" + (f"/{e.cc_method}" if e.cc_method else "")
            date_line = f"{e.d.day} {e.d:%b} '{e.d:%y}" + (f" \u2022 {e.cc_method}" if e.cc_method else "")
            out.append(ParsedTxn(
                date=ts, description=e.description, debit=e.debit, credit=e.credit,
                balance=0.0, source="Slice-CC", source_file=src,
                txn_mode=mode,
                txn_reference=slice_cc_parser._hash_ref(e.d.isoformat(), e.cc_merchant, amt),
                txn_counterparty=e.cc_merchant,
                txn_raw_description=" | ".join([f"{e.cc_merchant} {amt:g}", "\u20b9", date_line]),
            ))
    return out


# ---------------------------------------------------------------------------
# 3. Ingestion through the real pipeline (minus the PDF step)
# ---------------------------------------------------------------------------


def ingest_statement(session, account: str, parsed: List[ParsedTxn]) -> IngestionResult:
    """Mirror of ``IngestionService.ingest_pdf_bytes`` steps 3-10."""
    svc = IngestionService(session)
    bank_id = ACCOUNT_BANK[account]
    _parser_cls, account_name, account_type, display_name = BANK_REGISTRY[bank_id]
    filename = STATEMENT_FILES[account]
    result = IngestionResult(filename=filename, bank=bank_id, account_name=account_name)
    svc._ensure_account(account_name, account_type, display_name)

    result.pages_parsed = max(1, len(parsed) // 28 + 1)
    result.parsed_count = len(parsed)
    rows = svc._rows_from_parsed(parsed, account_name, account_type, display_name, filename)
    dates = sorted(r["date"].isoformat() for r in rows)
    result.period_start, result.period_end = dates[0], dates[-1]

    result.cc_payments_tagged = svc.linker.flag_cc_payments_in_dicts(rows)
    result.income_autotagged = apply_income_autotag(rows)
    result.rules_applied = svc.cat.apply_rules_to_dicts(rows)
    inserted = svc._insert_rows(rows)
    result.new_count = inserted
    result.duplicate_count = len(rows) - inserted
    if inserted:
        svc.linker.link_cc_payments()
        svc.linker.detect_internal_transfers()
    fhash = file_sha256(f"finance-hub-demo|{filename}|{SEED}".encode())
    svc._record_upload(filename, fhash, bank_id, result)
    return result


# ---------------------------------------------------------------------------
# 4. Taxonomy + saved rules (what a user would have set up in the UI)
# ---------------------------------------------------------------------------


def setup_taxonomy(session) -> None:
    tax = CategoryTaxonomyService(session)

    def node(name: str, parent: Optional[int]) -> Optional[CategoryDefinition]:
        q = select(CategoryDefinition).where(CategoryDefinition.name == name)
        q = q.where(CategoryDefinition.parent_id.is_(None) if parent is None
                    else CategoryDefinition.parent_id == parent)
        return session.scalar(q)

    travel = node("Travel", None)
    gifts = node("Gifts", None)
    # Demo-only renames of personal category names.
    tax.rename(node("Travel to Girlfriend", travel.id).id, "Visiting Friends")
    tax.rename(node("Girlfriend", gifts.id).id, "Friends")

    additions = {
        "Bills & Utilities": ["Rent", "Electricity", "Broadband", "Mobile"],
        "Personal": ["Entertainment", "Subscriptions", "Health"],
        "Shopping": ["Online Shopping", "Clothing"],
        "Electronics": ["Tablet"],
    }
    for root_name, subs in additions.items():
        root = node(root_name, None)
        for sub in subs:
            if node(sub, root.id) is None:
                tax.create(sub, parent_id=root.id)
    # Bonus as its own income source, so it doesn't inflate "Salary".
    if node("Bonus", None) is None:
        tax.create("Bonus", parent_id=None, kind="income")


RULES: List[Tuple[str, str, str, Optional[str], Optional[str]]] = [
    # (rule_type, value, category, subcategory, sub_subcategory)
    ("vpa", VPA["swiggy"], "Food", "Online Ordering", None),
    ("vpa", VPA["zomato"], "Food", "Online Ordering", None),
    ("vpa", VPA["blinkit"], "Food", "Groceries", None),
    ("vpa", VPA["zepto"], "Food", "Groceries", None),
    ("vpa", VPA["more"], "Food", "Groceries", None),
    ("vpa", VPA["meghana"], "Food", "Dine-out", None),
    ("vpa", VPA["rapido"], "Travel", "Daily Commute", "Rapido"),
    ("vpa", VPA["uber"], "Travel", "Daily Commute", "Uber"),
    ("vpa", VPA["ola"], "Travel", "Daily Commute", "Ola"),
    ("vpa", VPA["metro"], "Travel", "Daily Commute", "Metro"),
    ("vpa", VPA["landlord"], "Bills & Utilities", "Rent", None),
    ("vpa", VPA["bescom"], "Bills & Utilities", "Electricity", None),
    ("vpa", VPA["act"], "Bills & Utilities", "Broadband", None),
    ("vpa", VPA["airtel"], "Bills & Utilities", "Mobile", None),
    ("vpa", VPA["mother"], "Gifts", "Family", None),
    ("merchant", "Swiggy", "Food", "Online Ordering", None),
    ("merchant", "Zomato", "Food", "Online Ordering", None),
    ("merchant", "Blinkit", "Food", "Groceries", None),
    ("merchant", "Zepto", "Food", "Groceries", None),
    ("merchant", "Rapido", "Travel", "Daily Commute", "Rapido"),
    ("merchant", "Uber", "Travel", "Daily Commute", "Uber"),
    ("keyword", "amazon pay india", "Shopping", "Online Shopping", None),
    ("keyword", "flipkart", "Shopping", "Online Shopping", None),
    ("keyword", "myntra", "Shopping", "Clothing", None),
    ("keyword", "avenue supermarts", "Food", "Groceries", None),
    ("keyword", "netflix", "Personal", "Subscriptions", None),
    ("keyword", "spotify", "Personal", "Subscriptions", None),
    ("keyword", "bookmyshow", "Personal", "Entertainment", None),
    ("keyword", "pvr inox", "Personal", "Entertainment", None),
    ("keyword", "apollo pharmacy", "Personal", "Health", None),
    ("keyword", "truffles", "Food", "Dine-out", None),
    ("keyword", "air india express", "Travel", "Travel to Home", "Flight"),
    ("keyword", "indigo 6e", "Travel", "Other Travel", None),
    ("keyword", "makemytrip", "Travel", "Other Travel", None),
    ("keyword", "redbus", "Travel", "Visiting Friends", None),
    ("keyword", "zerodha", "Investments", "Mutual Funds", None),
]


def setup_rules(session) -> None:
    cat = CategorizationService(session)
    for rtype, value, c, s, ss in RULES:
        cat.upsert_rule(rtype, value, c, s, ss, propagate=False)


# ---------------------------------------------------------------------------
# 5. Post-ingest user actions
# ---------------------------------------------------------------------------


def find_one(session, account: str, d: date, needle: str, amount: Optional[float] = None) -> Transaction:
    q = select(Transaction).where(
        Transaction.account_name == account,
        Transaction.date == d,
        func.lower(Transaction.description).like(f"%{needle.lower()}%"),
    )
    if amount is not None:
        q = q.where(func.abs(Transaction.amount - amount) < 0.005)
    rows = list(session.scalars(q))
    if len(rows) != 1:
        raise RuntimeError(f"expected one row for {account} {d} {needle!r}, got {len(rows)}")
    return rows[0]


def set_refund(session, t: Transaction, category: str, sub: str, refund_category: str) -> None:
    CategorizationService(session).set_transaction_category(t.id, category, sub)
    t = session.get(Transaction, t.id)
    t.is_refund = True
    t.refund_category = refund_category
    session.commit()


def user_actions(session) -> dict:
    cat = CategorizationService(session)
    link = LinkingService(session)
    out: dict = {}

    # Manual re-tags.
    phone = find_one(session, "SBI_CC", date(2026, 8, 14), "flipkart", 10999.00)
    cat.set_transaction_category(phone.id, "Electronics", "Phone")
    ipad = find_one(session, "SBI", date(2026, 10, 18), "apple india", 99900.00)
    cat.set_transaction_category(ipad.id, "Electronics", "Tablet")
    med = find_one(session, "SBI", date(2026, 8, 22), "apollo", 30000.00)
    cat.set_transaction_category(med.id, "Personal", "Health")
    for d, amt in [(date(2026, 10, 15), 200000.00), (date(2026, 10, 23), 18000.00)]:
        bonus = find_one(session, "SBI", d, "bonus", amt)
        cat.set_transaction_category(bonus.id, "Income", "Bonus")
    gift = find_one(session, "SBI_CC", date(2026, 9, 24), "gift card", 2000.00)
    cat.set_transaction_category(gift.id, "Gifts", "Friends")
    for d, needle in [(date(2026, 10, 11), "martins corner"), (date(2026, 10, 12), "brittos")]:
        t = find_one(session, "SBI_CC", d, needle)
        cat.set_transaction_category(t.id, "Travel", "Other Travel")

    # EMI conversion of the phone purchase: 6 monthly instalments.
    emi = EMIService(session).convert_to_emi(
        phone.id, 6, note="Flipkart phone purchase converted to 6-month EMI on SBI Card",
    )
    out["emi_id"] = emi.id

    # Refunds and shared-expense recoveries (what the PATCH route does).
    set_refund(session, find_one(session, "SBI_CC", date(2026, 9, 9), "refund"),
               "Refunds & Recoveries", "Merchant Refund", "Shopping")
    set_refund(session, find_one(session, "SLICE", date(2026, 8, 11), "refund"),
               "Refunds & Recoveries", "Merchant Refund", "Food")
    set_refund(session, find_one(session, "SBI", date(2026, 8, 24), "karthik rao"),
               "Refunds & Recoveries", "Shared Expense Recovery", "Food")
    set_refund(session, find_one(session, "SBI", date(2026, 10, 16), "ananya iyer"),
               "Refunds & Recoveries", "Shared Expense Recovery", "Travel")

    # Map every auto-flagged card-bill payment to the statement it settled
    # (the "Mark as CC payment" dialog -> LinkingService.mark_cc_bill_payment).
    mapped = 0
    for t in session.scalars(select(Transaction).where(
        Transaction.is_credit_card_payment.is_(True),
        Transaction.account_type == ACCOUNT_TYPE_SAVINGS,
    )).all():
        cc = "SBI_CC" if "sbi card" in t.description.lower() else "SLICE_CC"
        prev = (t.date.replace(day=1) - timedelta(days=1))
        link.mark_cc_bill_payment(t.id, cc, f"{prev:%Y-%m}")
        mapped += 1
    out["cc_bills_mapped"] = mapped

    # The card-side receipt of each bill payment is tagged with the
    # "Internal Transfer" convention analytics already honours, via the
    # Categorize page's "apply to all similar" path (saves a merchant rule).
    for merchant in ("Payment Received", "Repayment"):
        cat.apply_category_to_group(kind="merchant", value=merchant, category="Internal Transfer")

    # Final sweep, same as after any upload.
    link.link_cc_payments()
    link.detect_internal_transfers()
    return out


# ---------------------------------------------------------------------------
# 6. Blinkit
# ---------------------------------------------------------------------------


def seed_blinkit(session, plans: List[BlinkitPlan]) -> dict:
    svc = BlinkitIngestionService(session)
    files = [
        ScannedFile(filename=p.invoice.source_file, file_hash=p.invoice.source_file_hash,
                    pages_found=1, orders_extracted=1)
        for p in plans
    ]
    svc._record_scanned_files(files)
    session.flush()
    for p in plans:
        with session.begin_nested():
            svc._persist_invoice(p.invoice)
    session.commit()
    res = BlinkitCategorizationService(session).categorize_all()
    session.commit()
    return {"orders": len(plans), "products_categorised": res.products_processed,
            "llm_used": res.llm_used}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def _reset_generator_state() -> None:
    """Make every rebuild start from the same seed, even when called twice."""
    global _seq
    rng.seed(SEED)
    LEDGER.clear()
    _used_refs.clear()
    _seq = 0


def _drop_all_tables() -> None:
    """Drop every table in the bound DB (used for an in-place rebuild, where
    the running server holds the file open and it must not be deleted)."""
    with engine.connect() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys = OFF")
        names = [r[0] for r in conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )]
        for name in names:
            conn.exec_driver_sql(f'DROP TABLE IF EXISTS "{name}"')
        conn.commit()
        conn.exec_driver_sql("PRAGMA foreign_keys = ON")
    _database._schema_initialised = False


def _delete_db_files(path: str) -> None:
    for suffix in ("", "-wal", "-shm", "-journal"):
        try:
            os.remove(path + suffix)
        except FileNotFoundError:
            pass


class _NoLLMEnv:
    """Temporarily hide Gemini keys so Blinkit categorisation stays rule-based."""

    def __enter__(self):
        self._saved = {k: os.environ.pop(k) for k in _LLM_ENV_KEYS if k in os.environ}
        return self

    def __exit__(self, *exc):
        os.environ.update(self._saved)
        return False


def main(db_path: Optional[str] = None, verbose: bool = True) -> dict:
    """Rebuild the demo database from scratch and return a summary dict.

    ``db_path`` defaults to ``FINANCE_DB_PATH`` or ``backend/data/demo.db``
    and must never be ``finance.db`` (raises :class:`RefusedPath`).

    * If ``db_path`` is the DB this process's ``db`` package is bound to,
      the rebuild runs in-process: every table is dropped and recreated
      (the file is kept so open connections stay valid).
    * Otherwise (e.g. the API is serving a different DB) the script runs
      itself in a subprocess bound to ``db_path``, so this process's
      engine is never redirected.
    """
    path = resolve_db_path(db_path)
    bound = os.path.realpath(_database.DB_PATH)
    if path != bound:
        import json
        import subprocess
        env = dict(os.environ, FINANCE_DB_PATH=path)
        for k in _LLM_ENV_KEYS:
            env.pop(k, None)
        proc = subprocess.run(
            [sys.executable, os.path.abspath(__file__), "--json"],
            cwd=_BACKEND, env=env, capture_output=True, text=True, check=True,
        )
        summary = json.loads(proc.stdout.strip().splitlines()[-1])
        summary["mode"] = "subprocess"
        return summary

    if os.path.exists(path):
        _drop_all_tables()
    else:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    with _NoLLMEnv():
        summary = _seed(path, verbose)
    summary["mode"] = "in_process"
    return summary


def _seed(path: str, verbose: bool) -> dict:
    log = print if verbose else (lambda *a, **k: None)
    log(f"Demo DB: {path}")
    _reset_generator_state()
    init_db()
    blinkit_plans = build_blinkit_orders()
    plan = generate(blinkit_plans)

    with SessionLocal() as session:
        setup_taxonomy(session)
        setup_rules(session)
        session.commit()

        for account in ("SBI", "CANARA", "SLICE", "SBI_CC", "SLICE_CC"):
            parsed = to_parsed(account, LEDGER[account])
            r = ingest_statement(session, account, parsed)
            log(f"  ingested {account:<9} parsed={r.parsed_count:<4} new={r.new_count:<4} "
                  f"cc_flagged={r.cc_payments_tagged:<2} autotag={r.income_autotagged:<3} "
                  f"rules={r.rules_applied}")

        actions = user_actions(session)
        bl = seed_blinkit(session, blinkit_plans)

        # ---- summary ------------------------------------------------------
        log("\nRows by account:")
        for name, n in session.execute(
            select(Transaction.account_name, func.count()).group_by(Transaction.account_name)
        ):
            log(f"  {name:<9} {n}")
        total = session.scalar(select(func.count()).select_from(Transaction))
        ccpay = session.scalar(select(func.count()).where(Transaction.is_credit_card_payment.is_(True)))
        internal = session.scalar(select(func.count()).where(Transaction.is_internal_transfer.is_(True)))
        emi = session.scalar(select(func.count()).where(Transaction.is_emi.is_(True)))
        refunds = session.scalar(select(func.count()).where(Transaction.is_refund.is_(True)))
        flow = [
            t for t in session.scalars(select(Transaction).where(
                Transaction.is_internal_transfer.is_(False),
                Transaction.is_credit_card_payment.is_(False),
                Transaction.is_emi.is_(False),
            ))
        ]
        uncat = sum(1 for t in flow if not (t.category or "").strip())
        linked_cc = session.scalar(select(func.count()).where(
            Transaction.is_credit_card_payment.is_(True),
            Transaction.linked_transaction_id.is_not(None),
        ))
        log(f"\nTotal transactions: {total}")
        log(f"  is_credit_card_payment: {ccpay} (linked to CC-side credit: {linked_cc}; "
              f"cc_bill_links: {session.scalar(select(func.count()).select_from(CCBillLink))})")
        log(f"  is_internal_transfer:   {internal} rows = {internal // 2} pairs "
              f"(planned {plan['transfers']})")
        log(f"  is_emi:                 {emi} (emi_records: "
              f"{session.scalar(select(func.count()).select_from(EMIRecord))})")
        log(f"  is_refund:              {refunds}")
        log(f"  uncategorised real-flow rows: {uncat} of {len(flow)} "
              f"({100.0 * uncat / max(1, len(flow)):.1f}%)")
        log(f"  uploads: {session.scalar(select(func.count()).select_from(Upload))}")
        log(f"Blinkit: {bl['orders']} orders, "
              f"{session.scalar(select(func.count()).select_from(BlinkitOrderItem))} items, "
              f"{bl['products_categorised']} products categorised (llm_used={bl['llm_used']})")
        cats = Counter(session.scalars(select(BlinkitProductCategoryRecord.category)))
        log(f"  Blinkit product categories: {dict(cats)}")

        if internal // 2 != plan["transfers"]:
            log("WARNING: internal-transfer pairs differ from the planned count.")
        for acct, opening in OPENING.items():
            low = min(
                (t.balance for t in session.scalars(
                    select(Transaction).where(Transaction.account_name == acct))),
                default=opening,
            )
            if low < 0:
                log(f"WARNING: {acct} running balance goes negative (min {low}).")

        by_account = dict(session.execute(
            select(Transaction.account_name, func.count()).group_by(Transaction.account_name)
        ).all())
        summary = {
            "db_path": path,
            "transactions": total,
            "by_account": by_account,
            "cc_payments": ccpay,
            "internal_transfer_rows": internal,
            "emi_rows": emi,
            "refund_rows": refunds,
            "uncategorised_flow_rows": uncat,
            "flow_rows": len(flow),
            "blinkit_orders": bl["orders"],
            "cc_bills_mapped": actions["cc_bills_mapped"],
        }
    return summary



def _script_entry(argv: List[str]) -> int:
    import json
    as_json = "--json" in argv
    # Script mode: start from a fresh file.
    path = resolve_db_path()
    if os.path.realpath(_database.DB_PATH) == path:
        engine.dispose()
        _delete_db_files(path)
    summary = main(path, verbose=not as_json)
    if as_json:
        print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(_script_entry(sys.argv[1:]))
    except RefusedPath as exc:
        sys.exit(str(exc))
