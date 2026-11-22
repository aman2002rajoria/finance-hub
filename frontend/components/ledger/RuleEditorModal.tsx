"use client";

// Create or edit a rule (design.md §7 Modal). One primary: "Save rule".
// Tagging existing charges is a separate, previewed step ("Preview and tag")
// so nothing changes without seeing what matches first (§11.5).
//
// Rules built with the condition builder (v2 trees) are fully editable.
// VPA / merchant / keyword rules and older custom rules keep their match and
// only their category changes here.

import { useEffect, useMemo, useState } from "react";

import { CategoryPicker } from "@/components/CategoryPicker";
import { RuleBuilder } from "@/components/RuleBuilder";
import { RulePreviewDialog } from "@/components/RulePreviewDialog";
import { AlertBanner, Button, Input, Label, Modal } from "@/components/ui";
import { applyRuleTree, invalidateAll, upsertRule, useTaxonomy } from "@/lib/api";
import { emptyTree, inferKindFromCategory, serializeTree } from "@/lib/ruleBuilder";
import type { CategorizationRule, CategoryKind, ConditionTree } from "@/lib/types";

import { errorText, plural } from "./format";
import { isTree, ruleTitle, ruleWhen } from "./ruleText";

export interface RuleEditorSeed {
  /** Existing rule to edit. */
  rule?: CategorizationRule | null;
  /** New rule from a counterparty group or similar. */
  tree?: ConditionTree;
  name?: string;
  category?: string | null;
}

const slug = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 64);

export function RuleEditorModal({
  open, seed, onClose, onSaved,
}: {
  open: boolean;
  seed: RuleEditorSeed | null;
  onClose: () => void;
  /** Called with a sentence describing what happened. */
  onSaved: (message: string) => void;
}) {
  const { data: taxonomy } = useTaxonomy();
  const rule = seed?.rule ?? null;
  const treeMode = !rule || isTree(rule.conditions);

  const [name, setName] = useState("");
  const [tree, setTree] = useState<ConditionTree>(emptyTree());
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [category, setCategory] = useState<string | null>(null);
  const [subcategory, setSubcategory] = useState<string | null>(null);
  const [subSub, setSubSub] = useState<string | null>(null);
  const [retag, setRetag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const r = seed?.rule;
    setName(r ? ruleTitle(r) : seed?.name ?? "");
    setTree(r && isTree(r.conditions) ? (r.conditions as ConditionTree) : seed?.tree ?? emptyTree());
    const cat = r?.category ?? seed?.category ?? null;
    setCategory(cat);
    setSubcategory(r?.subcategory ?? null);
    setSubSub(r?.sub_subcategory ?? null);
    setKind(inferKindFromCategory(cat, taxonomy));
    setRetag(false);
    setError(null);
    setPreviewOpen(false);
    // taxonomy deliberately not a dependency: don't reset the form when it loads.
  }, [open, seed]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasConditions = useMemo(() => tree.items.length > 0, [tree]);
  const renamed = !!rule && treeMode && slug(name) !== rule.rule_value;
  const canSave = !!category && (treeMode ? !!name.trim() && hasConditions : true);

  async function save() {
    if (!canSave || !category) {
      setError(treeMode ? "Give the rule a name, at least one condition and a category." : "Pick a category.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (treeMode) {
        await upsertRule({
          rule_type: "heuristic",
          name: name.trim(),
          rule_value: slug(name),
          category,
          subcategory: subcategory || undefined,
          sub_subcategory: subSub || undefined,
          conditions: serializeTree(tree),
        });
        onSaved(`Saved “${name.trim()}”. It tags new statements from now on.`);
      } else if (rule) {
        await upsertRule({
          rule_type: rule.rule_type,
          rule_value: rule.rule_value,
          name: rule.name,
          category,
          subcategory: subcategory || null,
          sub_subcategory: subSub || null,
          conditions: rule.rule_type === "heuristic" ? rule.conditions : undefined,
          priority: rule.priority,
          enabled: rule.enabled,
          propagate: rule.rule_type !== "heuristic" && retag,
        });
        onSaved(retag
          ? `Saved. Every charge it matches is now ${category}.`
          : `Saved. New charges it matches become ${category}.`);
      }
      invalidateAll();
      onClose();
    } catch (e) {
      setError(`The rule didn't save: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveAndApply(onlyUncategorized: boolean) {
    if (!category || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await applyRuleTree({
        name: name.trim(),
        conditions: serializeTree(tree),
        category,
        subcategory: subcategory || undefined,
        sub_subcategory: subSub || undefined,
        only_uncategorized: onlyUncategorized,
      });
      invalidateAll();
      const skipped = r.skipped_manual ? ` ${plural(r.skipped_manual, "charge")} you tagged by hand stayed as they were.` : "";
      onSaved(`Saved “${name.trim()}” and tagged ${plural(r.transactions_updated, "charge")} as ${category}.${skipped}`);
      setPreviewOpen(false);
      onClose();
    } catch (e) {
      setPreviewOpen(false);
      setError(`The rule didn't save: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <>
      <Modal
        open={open && !previewOpen}
        onClose={onClose}
        title={rule ? "Edit rule" : "Create a rule"}
        width="max-w-[760px]"
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            {treeMode && (
              <Button variant="ghost" onClick={() => setPreviewOpen(true)} disabled={!hasConditions || busy}>
                Preview and tag
              </Button>
            )}
            <Button variant="primary" onClick={save} loading={busy} disabled={!canSave}>Save rule</Button>
            <p className="w-full text-right text-sm font-medium text-muted">
              {treeMode
                ? "Saving changes no charges yet. Preview to see and tag what it matches."
                : retag
                  ? "Retags every charge it matches, including ones you tagged by hand."
                  : "Charges it already tagged keep their tag."}
            </p>
          </>
        }
      >
        <div className="space-y-6">
          {error && <AlertBanner variant="danger">{error}</AlertBanner>}

          {treeMode ? (
            <>
              <div>
                <Label htmlFor="rule-name">Name</Label>
                <Input
                  id="rule-name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Swiggy is food"
                />
                {renamed && (
                  <p className="mt-2 text-sm text-muted">
                    A new name saves this as a new rule. The old one stays until you delete it.
                  </p>
                )}
              </div>
              <div>
                <p className="mb-3 text-[13px] font-semibold text-muted">When a transaction matches</p>
                <RuleBuilder tree={tree} onChange={setTree} />
              </div>
            </>
          ) : rule && (
            <div className="rounded-m bg-surface p-5">
              <p className="text-[17px] leading-snug text-ink-2">
                {ruleWhen(rule).lead}
                {ruleWhen(rule).value && <> <span className="font-semibold text-ink">{ruleWhen(rule).value}</span></>}
              </p>
              <p className="mt-1 text-sm text-muted">That part stays. Change what it tags below.</p>
            </div>
          )}

          <div>
            <p className="mb-3 text-[13px] font-semibold text-muted">Tag it as</p>
            <CategoryPicker
              kind={kind}
              category={category}
              subcategory={subcategory}
              sub_subcategory={subSub}
              showKindToggle
              onKindChange={k => { setKind(k); setCategory(null); setSubcategory(null); setSubSub(null); }}
              onChange={v => { setCategory(v.category); setSubcategory(v.subcategory); setSubSub(v.sub_subcategory); }}
              layout="chips"
            />
          </div>

          {!treeMode && rule && rule.rule_type !== "heuristic" && (
            <label className="flex cursor-pointer items-start gap-3 text-[15px] text-ink-2">
              <input
                type="checkbox"
                checked={retag}
                onChange={e => setRetag(e.target.checked)}
                className="mt-1 h-4 w-4 accent-accent-600"
              />
              <span>
                Also retag every charge it matches now
                {(rule.transactions_categorized ?? 0) > 0 && (
                  <span className="text-muted"> ({plural(rule.transactions_categorized ?? 0, "charge")} carry its tag today)</span>
                )}
              </span>
            </label>
          )}
        </div>
      </Modal>

      {treeMode && (
        <RulePreviewDialog
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
          conditions={tree}
          proposedCategory={category}
          proposedSubcategory={subcategory}
          defaultOnlyUncategorized
          onApply={saveAndApply}
          applyBusy={busy}
          title={name.trim() ? `Preview “${name.trim()}”` : "Preview this rule"}
        />
      )}
    </>
  );
}
