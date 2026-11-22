"use client";

// 3-level cascading category picker: Category → Subcategory → Sub-subcategory.
//
// Fully controlled: the parent owns the (category, subcategory,
// sub_subcategory) triple and is called whenever any level changes.
// Native <select>s keep it accessible and safe inside drawers and modals.
// "Add new…" opens a small inline field under the level instead of a
// browser prompt; archiving a category asks first in a confirm dialog.
// Validation lives on the backend (taxonomy.validate_path).

import clsx from "clsx";
import { useMemo, useState } from "react";

import { ConfirmDialog } from "@/components/ledger/primitives";
import { errorText } from "@/components/ledger/format";
import {
  archiveCategoryNode,
  createCategoryNode,
  refreshTaxonomy,
  useTaxonomy,
} from "@/lib/api";
import type { CategoryKind, CategoryNode } from "@/lib/types";

import { Button, Input, Label, Segmented, Select, Skeleton } from "./ui";

interface Props {
  /** Top-level: "expense" or "income". Filters the tree. */
  kind: CategoryKind;
  category: string | null;
  subcategory: string | null;
  sub_subcategory: string | null;
  onChange: (next: {
    category: string | null;
    subcategory: string | null;
    sub_subcategory: string | null;
  }) => void;
  /** Hide labels for compact embeds. */
  compact?: boolean;
  /** Show the Expense / Income switch. */
  showKindToggle?: boolean;
  onKindChange?: (kind: CategoryKind) => void;
  disabled?: boolean;
  /** "stack" (default), three columns side by side from 640px, or tappable chips. */
  layout?: "stack" | "row" | "chips";
}

/** One tappable option in the chips layout. Selected = accent tint with an accent ring. */
function PickChip({
  label, active, onClick, disabled, muted,
}: { label: string; active?: boolean; onClick: () => void; disabled?: boolean; muted?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "inline-flex items-center rounded-pill px-3.5 py-2 text-sm font-medium transition-[background,color,box-shadow,transform] duration-200 active:scale-[.96] disabled:opacity-50",
        active
          ? "bg-accent-50 text-accent-700 shadow-[0_0_0_1.5px_var(--accent-500)]"
          : muted
            ? "text-muted hover:bg-surface hover:text-ink"
            : "bg-card text-ink-2 shadow-flat hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}

const ADD_NEW = "__ADD_NEW__";
type Level = 1 | 2 | 3;

export function CategoryPicker(props: Props) {
  const {
    kind,
    category, subcategory, sub_subcategory,
    onChange, compact, disabled,
    showKindToggle, onKindChange,
    layout = "stack",
  } = props;
  const { data: taxonomy, isLoading } = useTaxonomy();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<Level | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const roots = useMemo<CategoryNode[]>(() => {
    if (!taxonomy) return [];
    return (kind === "income" ? taxonomy.income : taxonomy.expense).filter(n => !n.archived);
  }, [taxonomy, kind]);

  const catNode = roots.find(r => r.name === category) ?? null;
  const subNode = catNode?.children.find(c => !c.archived && c.name === subcategory) ?? null;
  const subSubNodes = subNode?.children.filter(c => !c.archived) ?? [];

  async function addNode(level: Level) {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      let parent_id: number | null = null;
      if (level === 2) {
        if (!catNode) return;
        parent_id = catNode.id;
      } else if (level === 3) {
        if (!subNode) return;
        parent_id = subNode.id;
      }
      await createCategoryNode({ name: trimmed, parent_id, kind: level === 1 ? kind : undefined });
      refreshTaxonomy();
      if (level === 1) onChange({ category: trimmed, subcategory: null, sub_subcategory: null });
      else if (level === 2) onChange({ category, subcategory: trimmed, sub_subcategory: null });
      else onChange({ category, subcategory, sub_subcategory: trimmed });
      setAdding(null);
      setNewName("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!catNode) return;
    setBusy(true);
    try {
      await archiveCategoryNode(catNode.id);
      refreshTaxonomy();
      setArchiveOpen(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function handleSelect(level: Level, value: string) {
    if (value === ADD_NEW) {
      setAdding(level);
      setNewName("");
      setError(null);
      return;
    }
    const v = value || null;
    if (level === 1) onChange({ category: v, subcategory: null, sub_subcategory: null });
    else if (level === 2) onChange({ category, subcategory: v, sub_subcategory: null });
    else onChange({ category, subcategory, sub_subcategory: v });
  }

  if (isLoading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading categories">
        <Skeleton className="h-12 w-full !rounded-pill" />
        <Skeleton className="h-12 w-full !rounded-pill" />
      </div>
    );
  }

  function addRow(level: Level) {
    if (adding !== level) return null;
    const what = level === 1 ? "category" : level === 2 ? "subcategory" : "sub-subcategory";
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input
          autoFocus
          aria-label={`New ${what} name`}
          placeholder={`New ${what} name`}
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); void addNode(level); }
            if (e.key === "Escape") { e.stopPropagation(); setAdding(null); }
          }}
          className="!h-10 min-w-0 flex-1 !text-sm"
        />
        <Button size="sm" onClick={() => addNode(level)} loading={busy} disabled={!newName.trim()}>
          Add {what}
        </Button>
        <button type="button" className="text-link text-sm" onClick={() => setAdding(null)}>Cancel</button>
      </div>
    );
  }

  const kindToggle = showKindToggle ? (
    <Segmented
      size="sm"
      ariaLabel="Money in or out"
      value={kind}
      onChange={k => !disabled && onKindChange?.(k)}
      options={[
        { value: "expense" as CategoryKind, label: "Money out" },
        { value: "income" as CategoryKind, label: "Money in" },
      ]}
    />
  ) : null;

  if (layout === "chips") {
    const subs = catNode?.children.filter(c => !c.archived) ?? [];
    const level = (lvl: Level, title: string, nodes: { id: number; name: string }[], value: string | null) => (
      <div>
        {!(compact && lvl === 1) && <p className="mb-2 text-[13px] font-semibold text-muted">{title}</p>}
        <div className="flex flex-wrap gap-2" role="group" aria-label={title}>
          {nodes.map(n => (
            <PickChip
              key={n.id}
              label={n.name}
              active={value === n.name}
              disabled={disabled || busy}
              onClick={() => handleSelect(lvl, value === n.name && lvl > 1 ? "" : n.name)}
            />
          ))}
          <PickChip muted label="+ New" disabled={disabled || busy} onClick={() => handleSelect(lvl, ADD_NEW)} />
        </div>
        {addRow(lvl)}
      </div>
    );
    return (
      <div className="space-y-5">
        {kindToggle}
        {level(1, "Category", roots, category)}
        {catNode && level(2, "Narrow it down (optional)", subs, subcategory)}
        {subNode && (subSubNodes.length > 0 || adding === 3) && level(3, `Within ${subNode.name} (optional)`, subSubNodes, sub_subcategory)}
        {error && <p role="alert" className="text-sm font-medium text-danger-text">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {showKindToggle && (
        <Segmented
          size="sm"
          ariaLabel="Money in or out"
          value={kind}
          onChange={k => !disabled && onKindChange?.(k)}
          options={[
            { value: "expense" as CategoryKind, label: "Expense" },
            { value: "income" as CategoryKind, label: "Income" },
          ]}
        />
      )}

      <div className={clsx(layout === "row" ? "grid gap-3 sm:grid-cols-3" : "space-y-3")}>
        <div>
          {!compact && (
            <div className="flex items-baseline justify-between gap-2">
              <Label>Category</Label>
              {catNode && (
                <button
                  type="button"
                  className="mb-2 text-[13px] font-semibold text-muted transition-colors hover:text-danger-text"
                  onClick={() => setArchiveOpen(true)}
                >
                  Archive
                </button>
              )}
            </div>
          )}
          <Select
            aria-label="Category"
            value={category ?? ""}
            onChange={e => handleSelect(1, e.target.value)}
            disabled={disabled || busy}
          >
            <option value="">No category</option>
            {roots.map(r => (
              <option key={r.id} value={r.name}>{r.name}</option>
            ))}
            <option value={ADD_NEW}>Add a new category…</option>
          </Select>
          {addRow(1)}
        </div>

        <div>
          {!compact && <Label>Subcategory</Label>}
          <Select
            aria-label="Subcategory"
            value={subcategory ?? ""}
            onChange={e => handleSelect(2, e.target.value)}
            disabled={disabled || busy || !catNode}
          >
            <option value="">None</option>
            {catNode?.children.filter(c => !c.archived).map(c => (
              <option key={c.id} value={c.name}>{c.name}</option>
            ))}
            {catNode ? <option value={ADD_NEW}>Add a new subcategory…</option> : null}
          </Select>
          {addRow(2)}
        </div>

        {(layout === "row" || (subNode && (subSubNodes.length > 0 || adding === 3))) && <div>
          {!compact && <Label>Sub-subcategory</Label>}
          <Select
            aria-label="Sub-subcategory"
            value={sub_subcategory ?? ""}
            onChange={e => handleSelect(3, e.target.value)}
            disabled={disabled || busy || !subNode}
          >
            <option value="">None</option>
            {subSubNodes.map(c => (
              <option key={c.id} value={c.name}>{c.name}</option>
            ))}
            {subNode ? <option value={ADD_NEW}>Add a new sub-subcategory…</option> : null}
          </Select>
          {addRow(3)}
        </div>}
      </div>

      {error && <p role="alert" className="text-sm font-medium text-danger-text">{error}</p>}

      <ConfirmDialog
        open={archiveOpen}
        title={`Archive ${catNode?.name ?? "this category"}?`}
        confirmLabel="Archive category"
        tone="danger"
        busy={busy}
        onConfirm={archive}
        onClose={() => setArchiveOpen(false)}
      >
        <p>
          It disappears from these lists. Charges already tagged{" "}
          <strong className="font-semibold text-ink">{catNode?.name}</strong> keep their tag.
        </p>
      </ConfirmDialog>
    </div>
  );
}
