"""Blinkit spending analytics — queries over normalized order tables."""

from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session

from db.models import BlinkitOrder, BlinkitOrderItem, BlinkitProductCategoryRecord, BLINKIT_LINE_PRODUCT
from services.blinkit_categorization_service import DEFAULT_CATEGORY, normalize_product_key

WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


class BlinkitAnalyticsService:
    def __init__(
        self,
        session: Session,
        date_from: Optional[date] = None,
        date_to: Optional[date] = None,
    ):
        self.s = session
        self.date_from = date_from
        self.date_to = date_to

    # ------------------------------------------------------------------
    # Filters
    # ------------------------------------------------------------------

    def _order_filter(self):
        clauses = []
        if self.date_from:
            clauses.append(BlinkitOrder.invoice_date >= self.date_from)
        if self.date_to:
            clauses.append(BlinkitOrder.invoice_date <= self.date_to)
        return and_(*clauses) if clauses else True

    def _orders_q(self):
        return select(BlinkitOrder).where(self._order_filter())

    def _items_join_q(self):
        return (
            select(BlinkitOrderItem, BlinkitOrder)
            .join(BlinkitOrder, BlinkitOrderItem.order_id == BlinkitOrder.id)
            .where(self._order_filter())
        )

    # ------------------------------------------------------------------
    # KPI summary
    # ------------------------------------------------------------------

    def summary(self) -> Dict[str, Any]:
        orders = self.s.scalars(self._orders_q()).all()
        if not orders:
            return self._empty_summary()

        totals = [o.grand_total or 0 for o in orders]
        discounts = [o.discount_total or 0 for o in orders if o.discount_total]
        distinct_order_ids = len({o.order_id for o in orders if o.order_id})

        item_q = self._items_join_q().where(BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT)
        product_items = self.s.execute(item_q).all()
        item_count = len(product_items)
        total_qty = sum(i.quantity or 0 for i, _ in product_items)

        total_spend = sum(totals)
        total_discount = sum(discounts)
        total_delivery = sum(o.delivery_fee or 0 for o in orders)
        total_handling = sum(o.handling_charge or 0 for o in orders)
        total_convenience = sum(o.convenience_fee or 0 for o in orders)
        total_tax = sum(o.tax_total or 0 for o in orders)

        product_keys = set()
        categories = set()
        for item, _ in product_items:
            product_keys.add(item.product_name)
            categories.add(item.category or DEFAULT_CATEGORY)

        return {
            "total_spend": round(total_spend, 2),
            "total_orders": len(orders),
            "distinct_order_ids": distinct_order_ids,
            "total_items": item_count,
            "total_quantity": round(total_qty, 2),
            "avg_order_value": round(total_spend / len(orders), 2) if orders else 0,
            "max_order_value": round(max(totals), 2) if totals else 0,
            "min_order_value": round(min(totals), 2) if totals else 0,
            "total_discount": round(total_discount, 2),
            "avg_discount_per_order": round(total_discount / len(orders), 2) if orders else 0,
            "discount_pct": round(100 * total_discount / (total_spend + total_discount), 2)
            if (total_spend + total_discount) > 0 else 0,
            "total_delivery_charges": round(total_delivery, 2),
            "total_handling_charges": round(total_handling, 2),
            "total_convenience_charges": round(total_convenience, 2),
            "total_taxes": round(total_tax, 2),
            "charges_pct_of_spend": round(
                100 * (total_delivery + total_handling + total_convenience) / total_spend, 2
            ) if total_spend else 0,
            "unique_products": len(product_keys),
            "unique_categories": len(categories),
            "unique_stores": len({o.store_name for o in orders if o.store_name}),
            "unique_sellers": len({o.seller_name for o in orders if o.seller_name}),
            "unique_locations": len({o.delivery_address for o in orders if o.delivery_address}),
        }

    def _empty_summary(self) -> Dict[str, Any]:
        keys = [
            "total_spend", "total_orders", "distinct_order_ids", "total_items",
            "total_quantity", "avg_order_value", "max_order_value", "min_order_value",
            "total_discount", "avg_discount_per_order", "discount_pct",
            "total_delivery_charges", "total_handling_charges", "total_convenience_charges",
            "total_taxes", "charges_pct_of_spend", "unique_products", "unique_categories",
            "unique_stores", "unique_sellers", "unique_locations",
        ]
        return {k: 0 for k in keys}

    # ------------------------------------------------------------------
    # Spending over time
    # ------------------------------------------------------------------

    def spending_over_time(self, granularity: str = "month") -> List[Dict[str, Any]]:
        orders = self.s.scalars(self._orders_q()).all()
        buckets: Dict[str, Dict[str, float]] = defaultdict(
            lambda: {
                "spend": 0, "discount": 0, "delivery": 0, "handling": 0,
                "convenience": 0, "order_count": 0,
            }
        )
        for o in orders:
            if not o.invoice_date:
                continue
            key = self._period_key(o.invoice_date, granularity)
            buckets[key]["spend"] += o.grand_total or 0
            buckets[key]["discount"] += o.discount_total or 0
            buckets[key]["delivery"] += o.delivery_fee or 0
            buckets[key]["handling"] += o.handling_charge or 0
            buckets[key]["convenience"] += o.convenience_fee or 0
            buckets[key]["order_count"] += 1

        result = []
        for k, v in sorted(buckets.items()):
            oc = int(v["order_count"])
            spend = round(v["spend"], 2)
            result.append({
                "period": k,
                "spend": spend,
                "discount": round(v["discount"], 2),
                "delivery": round(v["delivery"], 2),
                "handling": round(v["handling"], 2),
                "convenience": round(v["convenience"], 2),
                "order_count": oc,
                "avg_order_value": round(spend / oc, 2) if oc else 0,
            })
        return result

    @staticmethod
    def _period_key(d: date, granularity: str) -> str:
        if granularity == "day":
            return d.isoformat()
        if granularity == "week":
            iso = d.isocalendar()
            return f"{iso.year}-W{iso.week:02d}"
        return d.strftime("%Y-%m")

    # ------------------------------------------------------------------
    # Category analytics
    # ------------------------------------------------------------------

    def category_breakdown(self) -> List[Dict[str, Any]]:
        rows = self.s.execute(
            self._items_join_q().where(BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT)
        ).all()
        agg: Dict[str, Dict[str, Any]] = defaultdict(
            lambda: {"spend": 0, "quantity": 0, "orders": set(), "products": set()}
        )
        for item, order in rows:
            cat = item.category or DEFAULT_CATEGORY
            agg[cat]["spend"] += item.total_amount or 0
            agg[cat]["quantity"] += item.quantity or 0
            agg[cat]["orders"].add(order.id)
            agg[cat]["products"].add(item.product_name)

        total = sum(v["spend"] for v in agg.values()) or 1
        result = []
        for cat, v in agg.items():
            result.append({
                "category": cat,
                "total_spend": round(v["spend"], 2),
                "order_count": len(v["orders"]),
                "product_count": len(v["products"]),
                "total_quantity": round(v["quantity"], 2),
                "avg_spend": round(v["spend"] / len(v["orders"]), 2) if v["orders"] else 0,
                "pct_of_total": round(100 * v["spend"] / total, 2),
            })
        result.sort(key=lambda x: x["total_spend"], reverse=True)
        return result

    def subcategory_breakdown(self, category: str) -> List[Dict[str, Any]]:
        """Spend/orders/products grouped by subcategory within a primary category."""
        rows = self.s.execute(
            self._items_join_q().where(
                BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT,
                func.coalesce(BlinkitOrderItem.category, DEFAULT_CATEGORY) == category,
            )
        ).all()
        agg: Dict[str, Dict[str, Any]] = defaultdict(
            lambda: {"spend": 0, "quantity": 0, "orders": set(), "products": set()}
        )
        for item, order in rows:
            sub = item.subcategory or "Uncategorized"
            agg[sub]["spend"] += item.total_amount or 0
            agg[sub]["quantity"] += item.quantity or 0
            agg[sub]["orders"].add(order.id)
            agg[sub]["products"].add(item.product_name)

        total = sum(v["spend"] for v in agg.values()) or 1
        result = []
        for sub, v in agg.items():
            result.append({
                "subcategory": sub,
                "category": category,
                "total_spend": round(v["spend"], 2),
                "order_count": len(v["orders"]),
                "product_count": len(v["products"]),
                "total_quantity": round(v["quantity"], 2),
                "pct_of_category": round(100 * v["spend"] / total, 2),
            })
        result.sort(key=lambda x: x["total_spend"], reverse=True)
        return result

    def subcategory_rankings(self, limit: int = 15) -> List[Dict[str, Any]]:
        """All subcategories across primary categories, sorted by spend."""
        rows = self.s.execute(
            self._items_join_q().where(BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT)
        ).all()
        agg: Dict[str, Dict[str, Any]] = defaultdict(
            lambda: {"spend": 0, "category": DEFAULT_CATEGORY, "orders": set()}
        )
        for item, order in rows:
            cat = item.category or DEFAULT_CATEGORY
            sub = item.subcategory or "Uncategorized"
            key = f"{cat}|{sub}"
            agg[key]["spend"] += item.total_amount or 0
            agg[key]["category"] = cat
            agg[key]["subcategory"] = sub
            agg[key]["orders"].add(order.id)

        result = [{
            "category": v["category"],
            "subcategory": v["subcategory"],
            "total_spend": round(v["spend"], 2),
            "order_count": len(v["orders"]),
        } for v in agg.values()]
        result.sort(key=lambda x: x["total_spend"], reverse=True)
        return result[:limit]

    def category_monthly_trend(self) -> List[Dict[str, Any]]:
        """One row per (period, category) for multi-line trend chart."""
        rows = self.s.execute(
            self._items_join_q().where(BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT)
        ).all()
        buckets: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
        for item, order in rows:
            if not order.invoice_date:
                continue
            period = order.invoice_date.strftime("%Y-%m")
            cat = item.category or DEFAULT_CATEGORY
            buckets[period][cat] += item.total_amount or 0

        out: List[Dict[str, Any]] = []
        for period in sorted(buckets.keys()):
            for cat, spend in sorted(buckets[period].items()):
                out.append({"period": period, "category": cat, "spend": round(spend, 2)})
        return out

    def stacked_monthly_by_category(self) -> List[Dict[str, Any]]:
        """Monthly spend pivoted — one dict per month with category keys."""
        rows = self.s.execute(
            self._items_join_q().where(BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT)
        ).all()
        buckets: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
        categories: set = set()
        for item, order in rows:
            if not order.invoice_date:
                continue
            period = order.invoice_date.strftime("%Y-%m")
            cat = item.category or DEFAULT_CATEGORY
            categories.add(cat)
            buckets[period][cat] += item.total_amount or 0

        result = []
        for period in sorted(buckets.keys()):
            row: Dict[str, Any] = {"period": period}
            total = 0.0
            for cat in sorted(categories):
                val = round(buckets[period].get(cat, 0), 2)
                row[cat] = val
                total += val
            row["total"] = round(total, 2)
            result.append(row)
        return result

    def products_in_category(
        self, category: str, *, limit: int = 10, subcategory: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Top products within a primary (and optional sub) category."""
        q = self._items_join_q().where(
            BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT,
            func.coalesce(BlinkitOrderItem.category, DEFAULT_CATEGORY) == category,
        )
        if subcategory:
            q = q.where(func.coalesce(BlinkitOrderItem.subcategory, "Uncategorized") == subcategory)

        rows = self.s.execute(q).all()
        agg: Dict[str, Dict[str, Any]] = defaultdict(
            lambda: {"spend": 0, "quantity": 0, "times": 0, "subcategory": ""}
        )
        for item, _ in rows:
            a = agg[item.product_name]
            a["spend"] += item.total_amount or 0
            a["quantity"] += item.quantity or 0
            a["times"] += 1
            a["subcategory"] = item.subcategory or "Uncategorized"

        result = [{
            "product_name": name,
            "category": category,
            "subcategory": v["subcategory"],
            "total_spend": round(v["spend"], 2),
            "total_quantity": round(v["quantity"], 2),
            "times_purchased": v["times"],
        } for name, v in agg.items()]
        result.sort(key=lambda x: x["total_spend"], reverse=True)
        return result[:limit]

    def drilldown_summary(
        self,
        *,
        dimension: str,
        value: Optional[str] = None,
        charge_type: Optional[str] = None,
        discounted_only: bool = False,
        tax_only: bool = False,
        category_filter: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Aggregate KPIs for the current drill-down selection."""
        order_ids = self._order_ids_for_dimension(
            dimension, value, charge_type, discounted_only, tax_only, category_filter,
        )

        orders = self.s.scalars(self._orders_q()).all()
        if order_ids is not None:
            orders = [o for o in orders if o.id in order_ids]

        item_rows = self.s.execute(
            self._items_join_q().where(BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT)
        ).all()
        if order_ids is not None:
            item_rows = [(i, o) for i, o in item_rows if o.id in order_ids]

        if dimension == "category" and value:
            item_rows = [(i, o) for i, o in item_rows if (i.category or DEFAULT_CATEGORY) == value]
        if dimension == "subcategory" and value:
            item_rows = [
                (i, o) for i, o in item_rows
                if (i.subcategory or "Uncategorized") == value
                and (not category_filter or (i.category or DEFAULT_CATEGORY) == category_filter)
            ]
        if dimension == "product" and value:
            item_rows = [(i, o) for i, o in item_rows if i.product_name == value]

        total_spend = sum(o.grand_total or 0 for o in orders)
        product_names = {i.product_name for i, _ in item_rows}
        item_spend = sum(i.total_amount or 0 for i, _ in item_rows)

        return {
            "dimension": dimension,
            "value": value,
            "total_spend": round(total_spend, 2),
            "item_spend": round(item_spend, 2),
            "total_orders": len(orders),
            "total_products": len(product_names),
            "total_items": len(item_rows),
            "avg_order_value": round(total_spend / len(orders), 2) if orders else 0,
        }

    # ------------------------------------------------------------------
    # Product analytics
    # ------------------------------------------------------------------

    def product_rankings(self, limit: int = 20, sort_by: str = "spend") -> List[Dict[str, Any]]:
        rows = self.s.execute(
            self._items_join_q().where(BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT)
        ).all()
        agg: Dict[str, Dict[str, Any]] = defaultdict(
            lambda: {
                "category": DEFAULT_CATEGORY, "times": 0, "quantity": 0, "spend": 0,
                "discount": 0, "prices": [], "product_name": "",
            }
        )
        for item, _ in rows:
            key = item.product_name
            a = agg[key]
            a["product_name"] = item.product_name
            a["category"] = item.category or DEFAULT_CATEGORY
            a["times"] += 1
            a["quantity"] += item.quantity or 0
            a["spend"] += item.total_amount or 0
            a["discount"] += item.discount or 0
            if item.selling_price is not None:
                a["prices"].append(item.selling_price)

        result = []
        for _, v in agg.items():
            prices = v["prices"]
            result.append({
                "product_name": v["product_name"],
                "category": v["category"],
                "times_purchased": v["times"],
                "total_quantity": round(v["quantity"], 2),
                "total_spend": round(v["spend"], 2),
                "avg_price": round(sum(prices) / len(prices), 2) if prices else 0,
                "avg_discount": round(v["discount"] / v["times"], 2) if v["times"] else 0,
            })
        key_fn = (lambda x: x["total_quantity"]) if sort_by == "quantity" else (lambda x: x["total_spend"])
        result.sort(key=key_fn, reverse=True)
        return result[:limit]

    def product_detail(self, product_name: str) -> Dict[str, Any]:
        rows = self.s.execute(
            self._items_join_q().where(
                BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT,
                BlinkitOrderItem.product_name == product_name,
            ).order_by(BlinkitOrder.invoice_date)
        ).all()

        history = []
        stores: Dict[str, float] = defaultdict(float)
        for item, order in rows:
            history.append({
                "order_id": order.order_id,
                "invoice_number": order.invoice_number,
                "invoice_date": order.invoice_date.isoformat() if order.invoice_date else None,
                "quantity": item.quantity,
                "mrp": item.mrp,
                "selling_price": item.selling_price,
                "discount": item.discount,
                "total_amount": item.total_amount,
                "store_name": order.store_name,
            })
            if order.store_name:
                stores[order.store_name] += item.total_amount or 0

        cat_row = self.s.scalar(
            select(BlinkitProductCategoryRecord).where(
                BlinkitProductCategoryRecord.product_key == normalize_product_key(product_name),
            )
        )
        if not cat_row:
            # try by product name match
            cat_row = self.s.scalar(
                select(BlinkitProductCategoryRecord).where(
                    BlinkitProductCategoryRecord.product_name == product_name,
                ).limit(1)
            )

        return {
            "product_name": product_name,
            "category": rows[0][0].category if rows else DEFAULT_CATEGORY,
            "subcategory": rows[0][0].subcategory if rows else None,
            "total_spend": round(sum(h["total_amount"] or 0 for h in history), 2),
            "total_quantity": round(sum(h["quantity"] or 0 for h in history), 2),
            "times_purchased": len(history),
            "purchase_history": history,
            "stores": [{"store_name": k, "spend": round(v, 2)} for k, v in
                       sorted(stores.items(), key=lambda x: x[1], reverse=True)],
            "categorization_source": cat_row.source if cat_row else "rules",
            "ai_categorized": bool(cat_row.ai_categorized) if cat_row else False,
            "ai_model": cat_row.ai_model if cat_row else None,
            "ai_categorized_at": (
                cat_row.ai_categorized_at.isoformat() if cat_row and cat_row.ai_categorized_at else None
            ),
        }

    # ------------------------------------------------------------------
    # Store / seller / location
    # ------------------------------------------------------------------

    def store_breakdown(self) -> List[Dict[str, Any]]:
        orders = self.s.scalars(self._orders_q()).all()
        agg: Dict[str, Dict[str, Any]] = defaultdict(lambda: {"orders": 0, "spend": 0, "items": 0})
        for o in orders:
            name = o.store_name or "Unknown"
            agg[name]["orders"] += 1
            agg[name]["spend"] += o.grand_total or 0
            agg[name]["items"] += o.total_quantity or 0
        result = []
        for name, v in agg.items():
            result.append({
                "store_name": name,
                "order_count": v["orders"],
                "total_spend": round(v["spend"], 2),
                "avg_basket_size": round(v["items"] / v["orders"], 2) if v["orders"] else 0,
                "avg_order_value": round(v["spend"] / v["orders"], 2) if v["orders"] else 0,
            })
        result.sort(key=lambda x: x["total_spend"], reverse=True)
        return result

    def seller_breakdown(self) -> List[Dict[str, Any]]:
        orders = self.s.scalars(self._orders_q()).all()
        agg: Dict[str, Dict[str, float]] = defaultdict(lambda: {"orders": 0, "spend": 0})
        for o in orders:
            name = o.seller_name or "Unknown"
            agg[name]["orders"] += 1
            agg[name]["spend"] += o.grand_total or 0
        return sorted([
            {"seller_name": k, "order_count": int(v["orders"]),
             "total_spend": round(v["spend"], 2),
             "avg_order_value": round(v["spend"] / v["orders"], 2) if v["orders"] else 0}
            for k, v in agg.items()
        ], key=lambda x: x["total_spend"], reverse=True)

    def location_breakdown(self) -> Dict[str, Any]:
        orders = self.s.scalars(self._orders_q()).all()
        by_state: Dict[str, Dict[str, Any]] = defaultdict(lambda: {"spend": 0, "orders": 0})
        by_address: Dict[str, Dict[str, Any]] = defaultdict(lambda: {"spend": 0, "orders": 0})
        for o in orders:
            state = o.delivery_state or "Unknown"
            addr = o.delivery_address or "Unknown"
            by_state[state]["spend"] += o.grand_total or 0
            by_state[state]["orders"] += 1
            by_address[addr]["spend"] += o.grand_total or 0
            by_address[addr]["orders"] += 1

        def _fmt(d):
            return sorted([
                {**{"name": k}, **{kk: round(vv, 2) if isinstance(vv, float) else vv
                                   for kk, vv in v.items()},
                 "avg_order_value": round(v["spend"] / v["orders"], 2) if v["orders"] else 0}
                for k, v in d.items()
            ], key=lambda x: x["spend"], reverse=True)

        return {"by_state": _fmt(by_state), "by_address": _fmt(by_address)}

    # ------------------------------------------------------------------
    # Order distribution, charges, discounts, taxes, behavior, brands
    # ------------------------------------------------------------------

    def order_value_buckets(self) -> List[Dict[str, Any]]:
        orders = self.s.scalars(self._orders_q()).all()
        buckets = {"₹0-250": 0, "₹250-500": 0, "₹500-1000": 0, "₹1000+": 0}
        for o in orders:
            v = o.grand_total or 0
            if v <= 250:
                buckets["₹0-250"] += 1
            elif v <= 500:
                buckets["₹250-500"] += 1
            elif v <= 1000:
                buckets["₹500-1000"] += 1
            else:
                buckets["₹1000+"] += 1
        return [{"bucket": k, "count": v} for k, v in buckets.items()]

    def charges_over_time(self) -> List[Dict[str, Any]]:
        return [
            {**row, "delivery_pct": round(100 * row["delivery"] / row["spend"], 2) if row["spend"] else 0,
             "handling_pct": round(100 * row["handling"] / row["spend"], 2) if row["spend"] else 0}
            for row in self.spending_over_time("month")
        ]

    def discount_analytics(self) -> Dict[str, Any]:
        monthly = self.spending_over_time("month")
        by_cat = self.category_breakdown()
        products = self.product_rankings(limit=10, sort_by="spend")
        top_disc = sorted(products, key=lambda x: x["avg_discount"], reverse=True)[:10]
        return {
            "monthly": [{"period": m["period"], "discount": m["discount"]} for m in monthly],
            "by_category": sorted(by_cat, key=lambda x: x.get("total_spend", 0), reverse=True)[:15],
            "top_discounted_products": top_disc,
        }

    def tax_analytics(self) -> Dict[str, Any]:
        orders = self.s.scalars(self._orders_q()).all()
        total_spend = sum(o.grand_total or 0 for o in orders) or 1
        total_cgst = sum(o.cgst_total or 0 for o in orders)
        total_sgst = sum(o.sgst_total or 0 for o in orders)
        monthly: Dict[str, Dict[str, float]] = defaultdict(lambda: {"cgst": 0, "sgst": 0, "tax": 0})
        for o in orders:
            if not o.invoice_date:
                continue
            k = o.invoice_date.strftime("%Y-%m")
            monthly[k]["cgst"] += o.cgst_total or 0
            monthly[k]["sgst"] += o.sgst_total or 0
            monthly[k]["tax"] += o.tax_total or 0

        by_cat: Dict[str, float] = defaultdict(float)
        for item, order in self.s.execute(
            self._items_join_q().where(BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT)
        ).all():
            cat = item.category or DEFAULT_CATEGORY
            by_cat[cat] += (item.cgst_inr or 0) + (item.sgst_inr or 0)

        return {
            "total_cgst": round(total_cgst, 2),
            "total_sgst": round(total_sgst, 2),
            "tax_pct": round(100 * (total_cgst + total_sgst) / total_spend, 2),
            "monthly": [{"period": k, **{kk: round(vv, 2) for kk, vv in v.items()}}
                        for k, v in sorted(monthly.items())],
            "by_category": [{"category": k, "tax": round(v, 2)}
                            for k, v in sorted(by_cat.items(), key=lambda x: x[1], reverse=True)],
        }

    def shopping_behavior(self) -> Dict[str, Any]:
        orders = sorted(
            [o for o in self.s.scalars(self._orders_q()).all() if o.invoice_date],
            key=lambda o: o.invoice_date,
        )
        if not orders:
            return {}

        qtys = [o.total_quantity or 0 for o in orders]
        by_weekday = defaultdict(int)
        by_dom = defaultdict(int)
        by_month = defaultdict(lambda: {"count": 0, "spend": 0})

        for o in orders:
            by_weekday[o.invoice_date.weekday()] += 1
            by_dom[o.invoice_date.day] += 1
            mk = o.invoice_date.strftime("%Y-%m")
            by_month[mk]["count"] += 1
            by_month[mk]["spend"] += o.grand_total or 0

        gaps = []
        for i in range(1, len(orders)):
            d = (orders[i].invoice_date - orders[i - 1].invoice_date).days
            gaps.append(d)

        most_active_month = max(by_month.items(), key=lambda x: x[1]["count"])[0] if by_month else None

        return {
            "avg_basket_size": round(sum(qtys) / len(qtys), 2) if qtys else 0,
            "avg_quantity_per_order": round(sum(qtys) / len(qtys), 2) if qtys else 0,
            "orders_per_weekday": [{"weekday": WEEKDAY_NAMES[i], "count": by_weekday[i]}
                                   for i in range(7)],
            "orders_by_day_of_month": [{"day": d, "count": c}
                                       for d, c in sorted(by_dom.items())],
            "orders_per_month": [{"period": k, "count": v["count"], "spend": round(v["spend"], 2)}
                                 for k, v in sorted(by_month.items())],
            "avg_gap_days": round(sum(gaps) / len(gaps), 1) if gaps else 0,
            "max_gap_days": max(gaps) if gaps else 0,
            "most_active_month": most_active_month,
        }

    def brand_breakdown(self, limit: int = 15) -> List[Dict[str, Any]]:
        rows = self.s.execute(
            self._items_join_q().where(
                BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT,
                BlinkitOrderItem.brand.isnot(None),
            )
        ).all()
        agg: Dict[str, Dict[str, float]] = defaultdict(lambda: {"spend": 0, "qty": 0, "orders": set()})
        for item, order in rows:
            brand = item.brand or "Unknown"
            agg[brand]["spend"] += item.total_amount or 0
            agg[brand]["qty"] += item.quantity or 0
            agg[brand]["orders"].add(order.id)
        result = [{
            "brand": k,
            "total_spend": round(v["spend"], 2),
            "total_quantity": round(v["qty"], 2),
            "order_count": len(v["orders"]),
        } for k, v in agg.items()]
        result.sort(key=lambda x: x["total_spend"], reverse=True)
        return result[:limit]

    # ------------------------------------------------------------------
    # Dynamic insights
    # ------------------------------------------------------------------

    def insights(self) -> List[str]:
        s = self.summary()
        if s["total_orders"] == 0:
            return ["No orders in the selected date range."]

        lines: List[str] = []
        cats = self.category_breakdown()
        if cats:
            top = cats[0]
            lines.append(
                f"You spent {top['pct_of_total']:.0f}% of your Blinkit expenses on {top['category']}."
            )

        monthly = self.spending_over_time("month")
        if monthly:
            peak = max(monthly, key=lambda x: x["spend"])
            lines.append(f"Your highest spending month was {peak['period']} (₹{peak['spend']:,.0f}).")

        if s["total_discount"] > 0:
            lines.append(f"You saved ₹{s['total_discount']:,.0f} through discounts.")

        if s["total_handling_charges"] > 0 and s["total_spend"] > 0:
            pct = 100 * s["total_handling_charges"] / s["total_spend"]
            lines.append(f"Handling charges account for {pct:.1f}% of total spend.")

        behavior = self.shopping_behavior()
        if behavior.get("orders_per_weekday"):
            top_day = max(behavior["orders_per_weekday"], key=lambda x: x["count"])
            if top_day["count"] > 0:
                lines.append(f"You order most frequently on {top_day['weekday']}s.")

        brands = self.brand_breakdown(limit=1)
        if brands:
            lines.append(f"{brands[0]['brand']} is your most purchased brand.")

        stores = self.store_breakdown()
        if stores:
            lines.append(f"{stores[0]['store_name']} fulfilled the most orders ({stores[0]['order_count']}).")

        locs = self.location_breakdown()
        if locs["by_state"] and s["total_spend"] > 0:
            top_state = locs["by_state"][0]
            pct = round(100 * top_state["spend"] / s["total_spend"])
            lines.append(f"{pct}% of spend was delivered to {top_state['name']}.")

        return lines

    # ------------------------------------------------------------------
    # Explorer (paginated full orders)
    # ------------------------------------------------------------------

    def explorer(
        self,
        *,
        q: Optional[str] = None,
        sort_by: str = "invoice_date",
        sort_dir: str = "desc",
        limit: int = 50,
        offset: int = 0,
    ) -> Tuple[List[Dict[str, Any]], int]:
        from sqlalchemy import or_

        base = select(BlinkitOrder).where(self._order_filter())
        count_q = select(func.count()).select_from(BlinkitOrder).where(self._order_filter())

        if q:
            like = f"%{q.strip()}%"
            filt = or_(
                BlinkitOrder.order_id.ilike(like),
                BlinkitOrder.invoice_number.ilike(like),
                BlinkitOrder.customer_name.ilike(like),
                BlinkitOrder.delivery_address.ilike(like),
                BlinkitOrder.seller_name.ilike(like),
                BlinkitOrder.store_name.ilike(like),
            )
            base = base.where(filt)
            count_q = count_q.where(filt)

        total = self.s.scalar(count_q) or 0
        col = getattr(BlinkitOrder, sort_by, BlinkitOrder.invoice_date)
        order_col = col.desc() if sort_dir == "desc" else col.asc()
        rows = self.s.scalars(base.order_by(order_col).offset(offset).limit(limit)).all()

        return [self._order_to_explorer_row(o) for o in rows], total

    # ------------------------------------------------------------------
    # Generic drill-down (orders + products)
    # ------------------------------------------------------------------

    _WEEKDAY_MAP = {name: i for i, name in enumerate(WEEKDAY_NAMES)}

    def drilldown(
        self,
        *,
        dimension: str,
        value: Optional[str] = None,
        tab: str = "orders",
        charge_type: Optional[str] = None,
        discounted_only: bool = False,
        tax_only: bool = False,
        category_filter: Optional[str] = None,
        q: Optional[str] = None,
        sort_by: str = "invoice_date",
        sort_dir: str = "desc",
        limit: int = 50,
        offset: int = 0,
    ) -> Tuple[List[Dict[str, Any]], int, str]:
        """Return paginated rows for a chart drill-down selection.

        ``tab`` is ``orders`` or ``products``. Returns (rows, total, label).
        """
        if tab == "products":
            return self._drilldown_products(
                dimension=dimension, value=value, charge_type=charge_type,
                discounted_only=discounted_only, tax_only=tax_only,
                category_filter=category_filter, q=q, sort_by=sort_by,
                sort_dir=sort_dir, limit=limit, offset=offset,
            )
        return self._drilldown_orders(
            dimension=dimension, value=value, charge_type=charge_type,
            discounted_only=discounted_only, tax_only=tax_only,
            category_filter=category_filter, q=q, sort_by=sort_by,
            sort_dir=sort_dir, limit=limit, offset=offset,
        )

    def _drilldown_label(self, dimension: str, value: Optional[str], charge_type: Optional[str]) -> str:
        labels = {
            "all": "All orders",
            "has_discount": "Discounted orders",
            "has_delivery": "Orders with delivery fees",
            "has_handling": "Orders with handling charges",
            "has_convenience": "Orders with convenience fees",
            "has_tax": "Orders with taxes",
        }
        if dimension in labels:
            return labels[dimension]
        dim_label = dimension.replace("_", " ").title()
        base = f"{dim_label}: {value}" if value else dim_label
        if charge_type:
            base += f" ({charge_type.title()} charges)"
        return base

    def _order_ids_for_dimension(
        self,
        dimension: str,
        value: Optional[str],
        charge_type: Optional[str] = None,
        discounted_only: bool = False,
        tax_only: bool = False,
        category_filter: Optional[str] = None,
    ) -> Optional[set]:
        """Return matching order PKs, or None when no item-level filter is needed."""
        if dimension == "all":
            return None

        orders = self.s.scalars(self._orders_q()).all()

        if dimension == "month" and value:
            y, m = map(int, value.split("-"))
            last = calendar.monthrange(y, m)[1]
            d_from = date(y, m, 1)
            d_to = date(y, m, last)
            ids = {o.id for o in orders if o.invoice_date and d_from <= o.invoice_date <= d_to}
        elif dimension == "day" and value:
            d = date.fromisoformat(value)
            ids = {o.id for o in orders if o.invoice_date == d}
        elif dimension == "weekday" and value:
            wd = self._WEEKDAY_MAP.get(value, -1)
            ids = {o.id for o in orders if o.invoice_date and o.invoice_date.weekday() == wd}
        elif dimension == "bucket" and value:
            ids = set()
            for o in orders:
                v = o.grand_total or 0
                if value == "₹0-250" and v <= 250:
                    ids.add(o.id)
                elif value == "₹250-500" and 250 < v <= 500:
                    ids.add(o.id)
                elif value == "₹500-1000" and 500 < v <= 1000:
                    ids.add(o.id)
                elif value == "₹1000+" and v > 1000:
                    ids.add(o.id)
        elif dimension == "store" and value:
            ids = {o.id for o in orders if o.store_name == value}
        elif dimension == "seller" and value:
            ids = {o.id for o in orders if o.seller_name == value}
        elif dimension == "state" and value:
            ids = {o.id for o in orders if o.delivery_state == value}
        elif dimension == "address" and value:
            ids = {o.id for o in orders if o.delivery_address == value}
        elif dimension == "has_discount":
            ids = {o.id for o in orders if (o.discount_total or 0) > 0}
        elif dimension == "has_delivery":
            ids = {o.id for o in orders if (o.delivery_fee or 0) > 0}
        elif dimension == "has_handling":
            ids = {o.id for o in orders if (o.handling_charge or 0) > 0}
        elif dimension == "has_convenience":
            ids = {o.id for o in orders if (o.convenience_fee or 0) > 0}
        elif dimension == "has_tax":
            ids = {o.id for o in orders if (o.tax_total or 0) > 0}
        elif dimension in ("category", "product", "brand", "subcategory"):
            rows = self.s.execute(
                self._items_join_q().where(BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT)
            ).all()
            ids = set()
            for item, order in rows:
                if dimension == "category" and (item.category or DEFAULT_CATEGORY) == value:
                    ids.add(order.id)
                elif dimension == "subcategory" and (item.subcategory or "Uncategorized") == value:
                    if category_filter and (item.category or DEFAULT_CATEGORY) != category_filter:
                        continue
                    ids.add(order.id)
                elif dimension == "product" and item.product_name == value:
                    ids.add(order.id)
                elif dimension == "brand" and (item.brand or "Unknown") == value:
                    ids.add(order.id)
        else:
            ids = set()

        if charge_type and value and dimension == "month":
            filtered = set()
            for o in orders:
                if o.id not in ids:
                    continue
                if charge_type == "delivery" and (o.delivery_fee or 0) > 0:
                    filtered.add(o.id)
                elif charge_type == "handling" and (o.handling_charge or 0) > 0:
                    filtered.add(o.id)
                elif charge_type == "convenience" and (o.convenience_fee or 0) > 0:
                    filtered.add(o.id)
            ids = filtered

        if discounted_only and dimension in ("month", "category", "all", "has_discount"):
            rows = self.s.execute(
                self._items_join_q().where(
                    BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT,
                    BlinkitOrderItem.discount.isnot(None),
                    BlinkitOrderItem.discount > 0,
                )
            ).all()
            disc_ids = set()
            for item, order in rows:
                if ids is not None and order.id not in ids:
                    continue
                if dimension == "category" and value and (item.category or DEFAULT_CATEGORY) != value:
                    continue
                if dimension == "month" and value and order.invoice_date:
                    y, m = map(int, value.split("-"))
                    if order.invoice_date.year != y or order.invoice_date.month != m:
                        continue
                disc_ids.add(order.id)
            ids = disc_ids if disc_ids else ids

        if tax_only and ids is not None:
            ids = {oid for oid in ids if any(
                (o.tax_total or 0) > 0 for o in orders if o.id == oid
            )}
        elif tax_only and ids is None:
            ids = {o.id for o in orders if (o.tax_total or 0) > 0}

        return ids

    def _drilldown_orders(
        self,
        *,
        dimension: str,
        value: Optional[str],
        charge_type: Optional[str],
        discounted_only: bool,
        tax_only: bool,
        category_filter: Optional[str],
        q: Optional[str],
        sort_by: str,
        sort_dir: str,
        limit: int,
        offset: int,
    ) -> Tuple[List[Dict[str, Any]], int, str]:
        from sqlalchemy import or_

        label = self._drilldown_label(dimension, value, charge_type)
        order_ids = self._order_ids_for_dimension(
            dimension, value, charge_type, discounted_only, tax_only, category_filter,
        )

        base = select(BlinkitOrder).where(self._order_filter())
        count_q = select(func.count()).select_from(BlinkitOrder).where(self._order_filter())

        if order_ids is not None:
            if not order_ids:
                return [], 0, label
            base = base.where(BlinkitOrder.id.in_(order_ids))
            count_q = count_q.where(BlinkitOrder.id.in_(order_ids))

        if q:
            like = f"%{q.strip()}%"
            filt = or_(
                BlinkitOrder.order_id.ilike(like),
                BlinkitOrder.invoice_number.ilike(like),
                BlinkitOrder.customer_name.ilike(like),
                BlinkitOrder.delivery_address.ilike(like),
                BlinkitOrder.seller_name.ilike(like),
                BlinkitOrder.store_name.ilike(like),
            )
            base = base.where(filt)
            count_q = count_q.where(filt)

        total = self.s.scalar(count_q) or 0
        col = getattr(BlinkitOrder, sort_by, BlinkitOrder.invoice_date)
        order_col = col.desc() if sort_dir == "desc" else col.asc()
        rows = self.s.scalars(base.order_by(order_col).offset(offset).limit(limit)).all()

        cat_map = self._category_summary_for_orders([o.id for o in rows])
        out = []
        for o in rows:
            row = self._order_to_explorer_row(o)
            row["category_summary"] = cat_map.get(o.id, "")
            out.append(row)
        return out, total, label

    def _category_summary_for_orders(self, order_ids: List[int]) -> Dict[int, str]:
        if not order_ids:
            return {}
        rows = self.s.execute(
            select(BlinkitOrderItem.order_id, BlinkitOrderItem.category)
            .where(
                BlinkitOrderItem.order_id.in_(order_ids),
                BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT,
            )
        ).all()
        agg: Dict[int, set] = defaultdict(set)
        for oid, cat in rows:
            agg[oid].add(cat or DEFAULT_CATEGORY)
        return {oid: ", ".join(sorted(cats)) for oid, cats in agg.items()}

    def _drilldown_products(
        self,
        *,
        dimension: str,
        value: Optional[str],
        charge_type: Optional[str],
        discounted_only: bool,
        tax_only: bool,
        category_filter: Optional[str],
        q: Optional[str],
        sort_by: str,
        sort_dir: str,
        limit: int,
        offset: int,
    ) -> Tuple[List[Dict[str, Any]], int, str]:
        from sqlalchemy import or_

        label = self._drilldown_label(dimension, value, charge_type)
        order_ids = self._order_ids_for_dimension(
            dimension, value, charge_type, discounted_only, tax_only, category_filter,
        )

        base = (
            select(BlinkitOrderItem, BlinkitOrder)
            .join(BlinkitOrder, BlinkitOrderItem.order_id == BlinkitOrder.id)
            .where(
                self._order_filter(),
                BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT,
            )
        )
        count_q = (
            select(func.count())
            .select_from(BlinkitOrderItem)
            .join(BlinkitOrder, BlinkitOrderItem.order_id == BlinkitOrder.id)
            .where(
                self._order_filter(),
                BlinkitOrderItem.line_type == BLINKIT_LINE_PRODUCT,
            )
        )

        if order_ids is not None:
            if not order_ids:
                return [], 0, label
            base = base.where(BlinkitOrder.id.in_(order_ids))
            count_q = count_q.where(BlinkitOrder.id.in_(order_ids))

        if dimension == "category" and value:
            base = base.where(
                func.coalesce(BlinkitOrderItem.category, DEFAULT_CATEGORY) == value
            )
            count_q = count_q.where(
                func.coalesce(BlinkitOrderItem.category, DEFAULT_CATEGORY) == value
            )
        elif dimension == "product" and value:
            base = base.where(BlinkitOrderItem.product_name == value)
            count_q = count_q.where(BlinkitOrderItem.product_name == value)
        elif dimension == "brand" and value:
            base = base.where(func.coalesce(BlinkitOrderItem.brand, "Unknown") == value)
            count_q = count_q.where(func.coalesce(BlinkitOrderItem.brand, "Unknown") == value)
        elif dimension == "subcategory" and value:
            base = base.where(func.coalesce(BlinkitOrderItem.subcategory, "Uncategorized") == value)
            count_q = count_q.where(func.coalesce(BlinkitOrderItem.subcategory, "Uncategorized") == value)
            if category_filter:
                base = base.where(func.coalesce(BlinkitOrderItem.category, DEFAULT_CATEGORY) == category_filter)
                count_q = count_q.where(func.coalesce(BlinkitOrderItem.category, DEFAULT_CATEGORY) == category_filter)

        if discounted_only:
            base = base.where(BlinkitOrderItem.discount.isnot(None), BlinkitOrderItem.discount > 0)
            count_q = count_q.where(BlinkitOrderItem.discount.isnot(None), BlinkitOrderItem.discount > 0)

        if q:
            like = f"%{q.strip()}%"
            filt = or_(
                BlinkitOrderItem.product_name.ilike(like),
                BlinkitOrderItem.brand.ilike(like),
                BlinkitOrderItem.category.ilike(like),
                BlinkitOrder.order_id.ilike(like),
                BlinkitOrder.store_name.ilike(like),
                BlinkitOrder.seller_name.ilike(like),
            )
            base = base.where(filt)
            count_q = count_q.where(filt)

        total = self.s.scalar(count_q) or 0

        sort_map = {
            "product_name": BlinkitOrderItem.product_name,
            "category": BlinkitOrderItem.category,
            "brand": BlinkitOrderItem.brand,
            "quantity": BlinkitOrderItem.quantity,
            "mrp": BlinkitOrderItem.mrp,
            "selling_price": BlinkitOrderItem.selling_price,
            "discount": BlinkitOrderItem.discount,
            "tax": BlinkitOrderItem.cgst_inr,
            "total_amount": BlinkitOrderItem.total_amount,
            "invoice_date": BlinkitOrder.invoice_date,
            "order_id": BlinkitOrder.order_id,
            "store_name": BlinkitOrder.store_name,
            "seller_name": BlinkitOrder.seller_name,
        }
        col = sort_map.get(sort_by, BlinkitOrder.invoice_date)
        order_col = col.desc() if sort_dir == "desc" else col.asc()
        rows = self.s.execute(base.order_by(order_col).offset(offset).limit(limit)).all()

        out = [self._item_to_drilldown_row(item, order) for item, order in rows]
        return out, total, label

    @staticmethod
    def _item_to_drilldown_row(item: BlinkitOrderItem, order: BlinkitOrder) -> Dict[str, Any]:
        tax = (item.cgst_inr or 0) + (item.sgst_inr or 0) + (item.igst_inr or 0)
        return {
            "id": item.id,
            "product_name": item.product_name,
            "category": item.category or DEFAULT_CATEGORY,
            "subcategory": item.subcategory or "Uncategorized",
            "brand": item.brand,
            "quantity": item.quantity,
            "mrp": item.mrp,
            "selling_price": item.selling_price,
            "discount": item.discount,
            "tax": round(tax, 2) if tax else None,
            "total_amount": item.total_amount,
            "order_row_id": order.id,
            "order_id": order.order_id,
            "invoice_number": order.invoice_number,
            "invoice_date": order.invoice_date.isoformat() if order.invoice_date else None,
            "seller_name": order.seller_name,
            "store_name": order.store_name,
        }

    def drilldown_export(
        self,
        *,
        dimension: str,
        value: Optional[str] = None,
        tab: str = "orders",
        charge_type: Optional[str] = None,
        discounted_only: bool = False,
        tax_only: bool = False,
        category_filter: Optional[str] = None,
        q: Optional[str] = None,
        limit: int = 10000,
    ) -> List[Dict[str, Any]]:
        rows, _, _ = self.drilldown(
            dimension=dimension, value=value, tab=tab, charge_type=charge_type,
            discounted_only=discounted_only, tax_only=tax_only,
            category_filter=category_filter, q=q, limit=limit, offset=0,
        )
        return rows

    @staticmethod
    def _order_to_explorer_row(o: BlinkitOrder) -> Dict[str, Any]:
        fees = (o.delivery_fee or 0) + (o.handling_charge or 0) + (o.convenience_fee or 0)
        return {
            "id": o.id,
            "order_id": o.order_id,
            "invoice_number": o.invoice_number,
            "invoice_date": o.invoice_date.isoformat() if o.invoice_date else None,
            "customer_name": o.customer_name,
            "delivery_address": o.delivery_address,
            "delivery_state": o.delivery_state,
            "delivery_pincode": o.delivery_pincode,
            "store_name": o.store_name,
            "seller_name": o.seller_name,
            "item_total": o.item_total,
            "discount_total": o.discount_total,
            "delivery_fee": o.delivery_fee,
            "handling_charge": o.handling_charge,
            "convenience_fee": o.convenience_fee,
            "tax_total": o.tax_total,
            "grand_total": o.grand_total,
            "total_quantity": o.total_quantity,
            "payment_method": o.payment_method,
            "source_file": o.source_file,
            "total_fees": round(fees, 2),
        }
