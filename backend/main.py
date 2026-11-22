"""FastAPI entry point.

Run with::

    uvicorn main:app --reload --port 8000

All HTTP endpoints live under ``/api`` (see the four route modules in
``api/``). The DB schema is created on startup so the very first run
out of the box works without any migration step.
"""

from __future__ import annotations

import logging
import os
import sys

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# Make project root importable when run directly via uvicorn from any cwd.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from api.routes_blinkit import router as blinkit_router
from api.routes_categorize import router as categorize_router
from api.routes_config import router as config_router
from api.routes_analytics import router as analytics_router
from api.routes_insights_v2 import router as insights_v2_router
from api.routes_categories import router as categories_router
from api.routes_emi import router as emi_router
from api.routes_rules import router as rules_router
from api.routes_system import router as system_router
from api.routes_transactions import router as transactions_router
from api.routes_upload import router as upload_router
from db.database import init_db


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s :: %(message)s",
)
logger = logging.getLogger("finance-hub")


# ---------------------------------------------------------------------------
# App + CORS
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    """Create tables on startup (idempotent).

    Using the modern lifespan API instead of the deprecated
    ``on_event('startup')`` hook so we work under FastAPI's
    :class:`TestClient` as well as production uvicorn.
    """
    init_db()
    logger.info("DB initialised; routes ready")
    yield


app = FastAPI(
    title="Personal Finance Hub",
    version="2.0.0",
    description=(
        "Multi-bank PDF statement parser with deterministic dedup, EMI "
        "handling, double-counting prevention, and rule-based "
        "categorisation."
    ),
    lifespan=_lifespan,
)

# Open CORS so the Next.js frontend (8080 / 3000) can call us in dev.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def _log_unhandled_errors(request: Request, exc: Exception):
    """Log full tracebacks for 500s — visible in the uvicorn terminal."""
    logger.exception("Unhandled %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})


# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------

app.include_router(blinkit_router)
app.include_router(upload_router)
app.include_router(transactions_router)
app.include_router(rules_router)
app.include_router(categorize_router)
app.include_router(config_router)
app.include_router(emi_router)
app.include_router(analytics_router)
app.include_router(insights_v2_router)
app.include_router(categories_router)
app.include_router(system_router)


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/")
def root() -> dict:
    return {
        "name": "Personal Finance Hub",
        "version": "2.0.0",
        "docs":    "/docs",
        "health":  "/health",
    }
