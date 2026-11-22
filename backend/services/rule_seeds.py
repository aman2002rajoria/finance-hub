"""Seed declarations for *system* (built-in) categorisation rules.

Adding a new system rule
------------------------
Append a dict to :data:`SYSTEM_RULES` and reboot the backend; the
:func:`sync_system_rules` helper is called from
:func:`db.database.init_db` and idempotently inserts / updates each
declared rule. System rules can be **disabled** by the user but never
deleted; if you need to retire a rule, remove the dict from this file —
``sync_system_rules`` won't touch existing user-disabled rows.

Each declaration uses the same shape as the persistence model so the
seeder is just a thin wrapper around :func:`sqlalchemy.update` /
:func:`sqlalchemy.insert`.

Schema for ``conditions`` is documented in
:mod:`services.rule_engine`. Keep heuristic rules narrow and
high-precision — false positives are a worse user experience than
"didn't auto-categorise".
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from db.models import RULE_TYPE_HEURISTIC, CategorizationRule


logger = logging.getLogger(__name__)


# Each entry must include: ``key``, ``name``, ``rule_type``, ``category``.
# Optional: ``subcategory``, ``sub_subcategory``, ``description``,
# ``priority`` (lower = evaluated first), ``conditions``.
#
# ``key`` is a stable identifier stored in ``rule_value`` so subsequent
# boots find the same row and update (rather than duplicate) the rule.

SYSTEM_RULES: List[Dict[str, Any]] = [
    {
        "key":         "system.travel.rapido_commute",
        "name":        "Daily Commute (first txn)",
        "description": (
            "Weekday morning commute heuristic: the first debit of each "
            "calendar day on each account, under ₹100, is tagged Commute → "
            "Office. Rider VPAs never say 'Rapido' on the statement, "
            "so we use day-of-week + first-debit-of-day + amount instead of "
            "merchant name matching."
        ),
        "rule_type":   RULE_TYPE_HEURISTIC,
        "category":    "Commute",
        "subcategory": "Office",
        "priority":    310,
        "conditions": {
            "type":               "debit",
            "amount":             {"max": 100, "exclusive_max": True},
            "day_of_week":        ["mon", "tue", "wed", "thu", "fri"],
            "first_debit_of_day": True,
            "description_excludes": [
                "dmrc", "metro", "zomato", "swiggy", "uber", "ola",
                "bee natural", "vending", "netflix", "amazon",
                "makemytrip", "irctc",
            ],
        },
    },
]


# ---------------------------------------------------------------------------
# Sync helper — invoked from db.database.init_db()
# ---------------------------------------------------------------------------


def sync_system_rules(session: Session) -> int:
    """Insert or update every declared system rule. Returns count touched.

    Idempotent — re-running on an existing DB just refreshes mutable
    fields (name, description, conditions, taxonomy). The user's
    ``enabled`` flag is **preserved** across reboots so toggling a
    system rule off in the UI sticks.
    """
    touched = 0
    for spec in SYSTEM_RULES:
        key = spec["key"]
        existing: Optional[CategorizationRule] = session.scalar(
            select(CategorizationRule).where(
                CategorizationRule.rule_type == spec["rule_type"],
                CategorizationRule.rule_value == key,
            )
        )
        conditions_json = (
            json.dumps(spec["conditions"], ensure_ascii=False)
            if spec.get("conditions") is not None else None
        )
        if existing is None:
            session.add(CategorizationRule(
                rule_type=spec["rule_type"],
                rule_value=key,
                name=spec["name"],
                description=spec.get("description"),
                category=spec["category"],
                subcategory=spec.get("subcategory"),
                sub_subcategory=spec.get("sub_subcategory"),
                priority=int(spec.get("priority", 300)),
                enabled=True,
                is_system=True,
                conditions_json=conditions_json,
            ))
            touched += 1
            continue

        existing.name             = spec["name"]
        existing.description      = spec.get("description")
        existing.category         = spec["category"]
        existing.subcategory      = spec.get("subcategory")
        existing.sub_subcategory  = spec.get("sub_subcategory")
        existing.priority         = int(spec.get("priority", existing.priority))
        existing.is_system        = True
        existing.conditions_json  = conditions_json
        # ``enabled`` is intentionally NOT overwritten — preserve user
        # preference across reboots.
        touched += 1

    return touched
