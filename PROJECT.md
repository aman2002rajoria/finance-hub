# Finance Hub

Every bank and card statement in one calm picture: what came in, what went out, what you saved and invested, your net worth, and whether your goals will happen.

## The problem
Money is spread across savings accounts, credit cards and investments. Statements are PDFs that don't agree with each other: card bills look like spending twice, transfers between your own accounts look like income, and one-offs like a bonus or an iPad distort every average. Finance Hub reads the statements, removes the double counting, and turns them into a few honest numbers and charts.

## What it does
- **Home:** for a chosen month, how much came in, what share was saved or invested, and four figures: spent, saved in bank, invested, net worth. Also a money-flow Sankey (income → invested, saved, spending), came in vs spent by month, a smooth net-worth line with auto-detected moments (🎉 bonus, 📱 iPad, 🏥 medical bill, 📉 market dips), and the next goals.
- **Spending:** where it went by category against a usual month; pace this month; fixed vs everyday vs lifestyle vs one-offs; top merchants; how you pay (UPI, card, EMIs); payments under ₹200; weekday vs weekend; recurring payments; then the ledger with in-place tagging.
- **Wealth:** net worth over time (bank cash + holdings − card dues); investments put in vs worth now; XIRR per holding against FD and Nifty; equity mix vs age target; emergency fund; health check; when locked money frees up (ELSS, FD, PPF, SGB).
- **Goals:** 3 goals with a real past (setbacks, pauses, top-ups) drawn against the original plan, then Monte Carlo outcome ranges and odds. It shows what each goal needs per month and what to change, plus an add-a-goal planner with what-ifs.
- **iOS designs:** 9 native-style screens on iPhone 16 Pro frames (`docs/portfolio/ios/`, live at `/showcase/ios`).
- **Test data mode:** a deterministic synthetic profile (a 27-year-old on ₹85k a month) so the app can be shown publicly without real data.

## Architecture
```
PDF statements ──► FastAPI backend (Python) ──► SQLite ──► REST API ──► Next.js frontend
                   parsers per bank                         /api (own data, :8000)
                   categorisation rules                     /demo-api (test data, :8001)
                   transfer / card-bill linking
                   analytics service
```
- **Backend** (`backend/`): FastAPI, SQLAlchemy 2, SQLite (WAL) and pdfplumber.
  - Parsers for SBI, SBI Card, slice, slice card and Canara.
  - Rule engine (VPA, merchant and keyword rules), refunds, EMIs, internal-transfer and card-bill linking.
  - Analytics: real spend, savings rate, monthly series, categories, net-worth series, card reconciliation, month insights, recurring payments.
  - `scripts/seed_demo_data.py` builds the synthetic `demo.db`.
- **Frontend** (`frontend/`): Next.js 14 App Router, TypeScript, Tailwind, Recharts, SWR, framer-motion.
  - `lib/wealth/`: the wealth engine. It combines statement data with holdings, goals and liabilities, and handles net worth, XIRR, the usual month (one-off-proof medians), Monte Carlo goal odds, event detection and the projection to retirement. Holdings and goals are stored in the browser for now; a backend for them is a later step.
  - The design system follows the portfolio brief: Fira Sans, a green accent ramp, light and dark themes via CSS variables, and a chart palette that follows the theme.

## Key decisions
- **Never count a rupee twice.** Card spend counts when you buy, not when the bill is paid. Self-transfers and investments are not spending.
- **Usual month = medians of complete months,** so a ₹2L bonus doesn't make you look rich and a ₹99.9k iPad doesn't make you look broke.
- **Odds, not straight lines.** Goals are simulated across many market paths, and their history shows real setbacks.
- **Charts over text.** Every card answers one question a person would act on.

## Run it
```bash
./dev.sh               # own data :8000 + test data :8001 + frontend :3000
./dev.sh --test-only   # public demo: test data only
```
Open http://localhost:3000/?mode=test. First run: `cd backend && python -m venv .venv && .venv/bin/pip install -r requirements.txt`, then `cd frontend && npm install`.

## What's next
Backend storage for holdings and goals, AI labelling of moments, more bank parsers, and a native iOS build.
