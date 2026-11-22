# Personal Finance Hub — v2.0

A self-hosted, multi-bank personal-finance system. Drop in your bank
and credit-card PDFs, let the parsers extract every transaction, and
get a fully-categorised, double-counting-safe analytics dashboard out
the other side.

## Stack

| Layer       | Tech                                                  |
|-------------|-------------------------------------------------------|
| Backend     | **FastAPI** · **SQLAlchemy 2.0** · **SQLite (WAL)**   |
| Parsers     | `pdfplumber` — SBI, SBI-CC, Slice, Slice-CC, Canara   |
| Frontend    | **Next.js 14 (App Router)** · **Tailwind** · **Recharts** · **SWR** |
| Persistence | `backend/data/finance.db` (one file, FK-enforced)     |

## Project layout

```
finance_hub/
├── backend/
│   ├── main.py                       # FastAPI entry
│   ├── api/                          # routes_*.py + Pydantic schemas
│   ├── db/                           # models.py, database.py
│   ├── services/                     # ingestion / dedup / linking / categorisation / EMI / analytics
│   ├── parsers/                      # bank-specific PDF extractors
│   ├── utils/                        # text / regex / excel helpers
│   ├── data/finance.db               # SQLite (auto-created)
│   └── scripts/smoke_test_backend.py
└── frontend/
    ├── app/                          # 5 pages: Dashboard / Upload / Transactions / Categorize / Analytics
    ├── components/                   # Sidebar, primitives, charts, EMI dialog
    └── lib/                          # api client, types, formatters
```

## Run

### 1. Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

* API: <http://localhost:8000>
* Swagger UI: <http://localhost:8000/docs>
* ReDoc: <http://localhost:8000/redoc>

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

* UI: <http://localhost:3000>

The Next.js config rewrites `/api/*` to the FastAPI server, so the
frontend never has to know the backend URL. To point at a different
host set `NEXT_PUBLIC_API_URL=https://api.example.com` before `npm run
dev` or `npm run build`.

## Key design decisions

See **`docs/CATEGORIZATION.md`** for the full architecture map (parsing,
VPA extraction, rule engine, tagged/untagged semantics, UI file paths).

### Double-counting prevention

Two independent flags on every transaction:

* `is_credit_card_payment` — the savings-side leg of a CC bill payment.
  Auto-detected from descriptions containing phrases like "SBI Card",
  "ccpay", "slice payment", etc.
* `is_internal_transfer` — same-amount, opposite-direction pair between
  two savings accounts inside a 5-day window.

Analytics excludes both from "real spend" so the same rupee is never
counted twice (CC purchase + savings transfer for the bill).

### EMI handling

When you convert a debit to an EMI plan, the original row stays in the
ledger flagged `is_emi=True`. The `emi_records` table stores the plan
(tenure, monthly amount, start date). Analytics **excludes the lump
sum** from spend and **adds projected monthly instalments** instead,
so an EMI'd flight ticket shows up as ₹3,333 across three months
rather than ₹10,000 in one.

### Deterministic dedup

Every transaction has a SHA-1 ID derived from
`(date | amount | description | account_name)` truncated to 16 hex
chars. Re-uploading the same PDF inserts zero new rows; a
re-rendered PDF with the same fields also collapses correctly.

In addition, the **file's SHA-256** is recorded in the `uploads` table,
so the same PDF re-uploaded under a different filename short-circuits
before parsing even starts.

### Rule engine

Three rule types, prioritised most-specific first:

1. **VPA** rules — exact match on `transactions.vpa`
2. **Merchant** rules — exact match on `transactions.merchant_name`
3. **Keyword** rules — case-insensitive substring of the description

Rules are applied on insert AND can be re-run over the whole ledger
via the "Re-apply rules" admin button.

### Counterparty extraction

VPA via regex (`*@okhdfc`, etc.) → merchant name via alias table
(Zomato / Swiggy / Amazon… auto-collapse) → fallback longest-non-noise
token. The Categorize page groups transactions by counterparty so you
can tag all 47 Zomato charges in one click.

## Sample data

Five test PDFs live in `~/Downloads/`:

* `sbi statement.pdf`
* `slice_statement_01Aug25_16May26.pdf`
* `canara bank statement.pdf`
* `slice Credit Card Statement - April 2026.pdf`
* `SBI Card Statement_8707_05-07-2025.pdf`

Drop them all into the Upload tab to populate the system.

## Smoke test

```bash
cd backend
python scripts/smoke_test_backend.py
```

Spins up the FastAPI app via `TestClient`, ingests all 5 PDFs,
exercises every endpoint family (upload, rules, EMI, analytics,
PATCH), and asserts results. Uses a temp DB so your real data is
untouched.

## Public demo on Vercel (test data only)

The public site runs as two Vercel projects from this repository, and both only ever show the made-up test data:

| Project | Root Directory | What it is |
| --- | --- | --- |
| `finance-hub-api` | `backend` | The FastAPI backend. On Vercel it builds the test data in a temp folder on first start (`seed_demo_data.py`), and uploads and clearing data are turned off. |
| `finance-hub` | `frontend` | The website. `frontend/.env.production` locks it to test data and points it at `https://finance-hub-api.vercel.app`. |

If the backend ends up at another address, change `NEXT_PUBLIC_DEMO_API_URL` in `frontend/.env.production` (or set it in the Vercel project's environment variables). No keys or secrets are needed. Your own `finance.db` and statements are never part of the repository.
