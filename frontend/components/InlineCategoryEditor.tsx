"use client";

/**
 * Compact category + subcategory editor for ledger rows.
 * Saves on change via PATCH /api/transactions/{id}; a failed save rolls the
 * select back and says so inline. See docs/CATEGORIZATION.md, Transactions tab.
 */

import clsx from "clsx";
import { useEffect, useMemo, useState } from "react";

import { errorText } from "@/components/ledger/format";
import { patchTransaction, useTaxonomy } from "@/lib/api";
import type { CategoryKind, Transaction } from "@/lib/types";

import { Select } from "./ui";

interface Props {
  txn: Transaction;
  onSaved?: () => void;
  /** Show the subcategory select only (category handled separately). */
  subcategoryOnly?: boolean;
  categoryOnly?: boolean;
}

function inferKind(txn: Transaction): CategoryKind {
  if (txn.type === "credit") return "income";
  const cat = (txn.category || "").toLowerCase();
  if (cat.includes("salary") || cat.includes("interest") || cat.includes("income")) {
    return "income";
  }
  return "expense";
}

// Small pill select sized for a 48px row.
const ROW_SELECT =
  "!h-9 !w-36 !pl-3.5 !pr-8 !text-sm !bg-[right_10px_center] !bg-[length:14px]";

export function InlineCategoryEditor({
  txn,
  onSaved,
  subcategoryOnly = false,
  categoryOnly = false,
}: Props) {
  const kind = inferKind(txn);
  const { data: taxonomy, isLoading } = useTaxonomy();
  const [cat, setCat] = useState(txn.category || "");
  const [sub, setSub] = useState(txn.subcategory || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCat(txn.category || "");
    setSub(txn.subcategory || "");
  }, [txn.id, txn.category, txn.subcategory]);

  const roots = useMemo(() => {
    if (!taxonomy) return [];
    return (kind === "income" ? taxonomy.income : taxonomy.expense).filter(n => !n.archived);
  }, [taxonomy, kind]);

  const subOptions = useMemo(() => {
    const node = roots.find(r => r.name === cat);
    return node?.children.filter(c => !c.archived) ?? [];
  }, [roots, cat]);

  async function persist(nextCat: string, nextSub: string) {
    setSaving(true);
    setError(null);
    try {
      await patchTransaction(txn.id, {
        category: nextCat || null,
        subcategory: nextSub || null,
      });
      onSaved?.();
    } catch (e: unknown) {
      setError(errorText(e));
      setCat(txn.category || "");
      setSub(txn.subcategory || "");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) return <div className="skeleton h-9 w-36 !rounded-pill" aria-hidden />;

  const errorNote = error ? (
    <span className="text-[13px] font-semibold text-danger-text" title={error} role="alert">
      Didn&apos;t save
    </span>
  ) : null;

  const categorySelect = (
    <Select
      aria-label="Category"
      className={clsx(ROW_SELECT, !cat && "!text-muted")}
      value={cat}
      disabled={saving}
      aria-busy={saving || undefined}
      onClick={e => e.stopPropagation()}
      onChange={e => {
        const v = e.target.value;
        setCat(v);
        setSub("");
        void persist(v, "");
      }}
    >
      <option value="">Add a tag</option>
      {roots.map(r => (
        <option key={r.id} value={r.name}>{r.name}</option>
      ))}
    </Select>
  );

  const subSelect = (
    <Select
      aria-label="Subcategory"
      className={clsx(ROW_SELECT, !sub && "!text-muted")}
      value={sub}
      disabled={!cat || saving || subOptions.length === 0}
      onClick={e => e.stopPropagation()}
      onChange={e => {
        const v = e.target.value;
        setSub(v);
        void persist(cat, v);
      }}
    >
      <option value="">{cat && subOptions.length === 0 ? "No subcategories" : "Subcategory"}</option>
      {subOptions.map(s => (
        <option key={s.id} value={s.name}>{s.name}</option>
      ))}
    </Select>
  );

  if (subcategoryOnly) {
    return <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>{subSelect}{errorNote}</div>;
  }
  if (categoryOnly) {
    return <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>{categorySelect}{errorNote}</div>;
  }
  return (
    <div className={clsx("flex items-center gap-2", saving && "opacity-60")} onClick={e => e.stopPropagation()}>
      {categorySelect}
      {subSelect}
      {errorNote}
    </div>
  );
}
