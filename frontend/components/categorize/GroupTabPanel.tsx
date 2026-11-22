"use client";

// The Categorise work area: a queue of counterparties on the left, the
// selected one on the right with its charges and one primary action,
// "Tag N charges as X" (design.md §8.4 list → detail, §11, §19).

import clsx from "clsx";
import { Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { CategoryPicker } from "@/components/CategoryPicker";
import { RulePreviewDialog } from "@/components/RulePreviewDialog";
import { TagFilterBar } from "@/components/TagFilterBar";
import { TransactionDetailDrawer } from "@/components/TransactionDetailDrawer";
import { categoryPath, dayMonth, errorText, plural } from "@/components/ledger/format";
import { cleanName } from "@/components/ledger/merchant";
import {
  Amount, ConfirmDialog, FieldLabel, ListSkeleton, ShortcutHint, SuggestionBlock,
  WhyThis, needsTag, useJkFocus,
} from "@/components/ledger/primitives";
import { MerchantAvatar } from "@/components/ledger/TxnList";
import {
  AiWorking, AlertBanner, Button, Card, Chip, EmptyState, ErrorCard, Input, Segmented, Select,
} from "@/components/ui";
import { bulkApplyCategory, invalidateAll, useCategorizeGroups, useTaxonomy, useTransactions } from "@/lib/api";
import { inr } from "@/lib/format";
import { inferKindFromCategory, parseCombinedKey, treeFromGroup } from "@/lib/ruleBuilder";
import type {
  CategoryKind, ConditionTree, EnrichedGroup, GroupFlowFilter, GroupSortKey,
  TagStatusFilter, TransactionFilters,
} from "@/lib/types";

type GroupKind = "vpa" | "merchant" | "combined";

const SORTS: { value: GroupSortKey; label: string; dir: "asc" | "desc" }[] = [
  { value: "uncategorized_count", label: "Most untagged first", dir: "desc" },
  { value: "expense_amount", label: "Biggest spend first", dir: "desc" },
  { value: "txn_count", label: "Most charges first", dir: "desc" },
  { value: "label", label: "Name, A to Z", dir: "asc" },
];

const PAGE = 60;

interface Props {
  kind: GroupKind;
  /** Group-by options, shown inside Filters (most people never change it). */
  kinds: { value: GroupKind; label: string }[];
  onKindChange: (k: GroupKind) => void;
  /** Noun for one group, e.g. "counterparty". */
  noun: string;
  onMakeRule: (tree: ConditionTree, name: string, category: string | null) => void;
  /** Sentence for the toast after tagging. */
  onTagged: (message: string) => void;
}

/** What the data says this group probably is (§11: label it, show why, show confidence). */
function suggestionFor(g: EnrichedGroup) {
  if (!g.top_category || g.uncategorized_count === 0) return null;
  const tagged = g.txn_count - g.uncategorized_count;
  const lowConfidence = tagged < 2 || tagged / g.txn_count < 0.5;
  return { category: g.top_category, tagged, lowConfidence };
}

export function GroupTabPanel({ kind, kinds, onKindChange, noun, onMakeRule, onTagged }: Props) {
  const { data: groups, error, isLoading, mutate } = useCategorizeGroups(kind);
  const { data: taxonomy } = useTaxonomy();

  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<TagStatusFilter>("untagged");
  const [sort, setSort] = useState<GroupSortKey>("uncategorized_count");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [flowFilter, setFlowFilter] = useState<GroupFlowFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [minTxns, setMinTxns] = useState("0");
  const [minAmount, setMinAmount] = useState("0");
  const [shown, setShown] = useState(PAGE);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const categoryOptions = useMemo(() => {
    const cats = new Set<string>();
    for (const g of groups ?? []) if (g.top_category) cats.add(g.top_category);
    return Array.from(cats).sort();
  }, [groups]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const minT = parseInt(minTxns, 10) || 0;
    const minA = parseFloat(minAmount) || 0;
    const rows = (groups ?? []).filter(g => {
      if (tagFilter === "tagged" && g.uncategorized_count > 0) return false;
      if (tagFilter === "untagged" && g.uncategorized_count === 0) return false;
      if (flowFilter === "expense" && g.expense_amount <= g.income_amount) return false;
      if (flowFilter === "income" && g.income_amount <= g.expense_amount) return false;
      if (categoryFilter && g.top_category !== categoryFilter) return false;
      if (g.txn_count < minT || g.total_amount < minA) return false;
      if (q && !g.label.toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = SORTS.find(s => s.value === sort)?.dir === "asc" ? 1 : -1;
    rows.sort((a, b) =>
      sort === "label" ? dir * a.label.localeCompare(b.label) : dir * ((a[sort] as number) - (b[sort] as number)));
    return rows;
  }, [groups, search, tagFilter, flowFilter, categoryFilter, minTxns, minAmount, sort]);

  useEffect(() => { setShown(PAGE); }, [search, tagFilter, flowFilter, categoryFilter, minTxns, minAmount, sort, kind]);
  useEffect(() => { setSelectedKey(null); }, [kind]);

  // Keep a selection once the list has loaded (desktop shows list and detail side by side).
  const selected = useMemo(
    () => (groups ?? []).find(g => g.key === selectedKey) ?? null,
    [groups, selectedKey],
  );

  // On desktop the right side is never empty: open the first in the queue.
  useEffect(() => {
    if (selectedKey || !filtered.length) return;
    if (typeof window !== "undefined" && window.innerWidth >= 1024) setSelectedKey(filtered[0].key);
  }, [filtered, selectedKey]);

  const extraFilters = [kind !== "merchant", flowFilter !== "all", !!categoryFilter, minTxns !== "0", minAmount !== "0"].filter(Boolean).length;

  useJkFocus(listRef, "[data-queue-item]");

  function open(g: EnrichedGroup) {
    setSelectedKey(g.key);
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }

  function selectNextAfter(key: string) {
    const idx = filtered.findIndex(g => g.key === key);
    const next = filtered[idx + 1] ?? filtered[idx - 1] ?? null;
    setSelectedKey(next && next.key !== key ? next.key : null);
  }

  const totalUntaggedGroups = (groups ?? []).filter(g => g.uncategorized_count > 0).length;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      {/* Queue */}
      <Card className="lg:col-span-5" padded={false}>
        <div className="space-y-3 p-5 pb-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" strokeWidth={1.75} />
            <Input
              type="search"
              aria-label={`Search by ${noun}`}
              placeholder={`Search by ${noun}`}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-12"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TagFilterBar value={tagFilter} onChange={setTagFilter} size="sm" label="Show" />
            <Button variant="ghost" size="sm" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(o => !o)}>
              <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} />
              {extraFilters ? `Filters · ${extraFilters}` : "Filters"}
            </Button>
          </div>
          {filtersOpen && (
            <div className="rise-in grid grid-cols-2 gap-3 rounded-m bg-surface p-4">
              <div className="col-span-2">
                <p className="mb-1.5 text-[13px] font-semibold text-muted">Group charges by</p>
                <Segmented ariaLabel="Group by" size="sm" value={kind} onChange={onKindChange} options={kinds} />
              </div>
              <div className="col-span-2">
                <FieldLabel htmlFor="q-sort">Order</FieldLabel>
                <Select id="q-sort" className="!h-10 !bg-card !text-sm" value={sort} onChange={e => setSort(e.target.value as GroupSortKey)}>
                  {SORTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </Select>
              </div>
              <div>
                <FieldLabel htmlFor="q-flow">Mostly</FieldLabel>
                <Select id="q-flow" className="!h-10 !bg-card !text-sm" value={flowFilter} onChange={e => setFlowFilter(e.target.value as GroupFlowFilter)}>
                  <option value="all">In or out</option>
                  <option value="expense">Money out</option>
                  <option value="income">Money in</option>
                </Select>
              </div>
              <div>
                <FieldLabel htmlFor="q-cat">Top category</FieldLabel>
                <Select id="q-cat" className="!h-10 !bg-card !text-sm" value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
                  <option value="">Any</option>
                  {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
                </Select>
              </div>
              <div>
                <FieldLabel htmlFor="q-min-t">At least</FieldLabel>
                <Select id="q-min-t" className="!h-10 !bg-card !text-sm" value={minTxns} onChange={e => setMinTxns(e.target.value)}>
                  <option value="0">Any number of charges</option>
                  <option value="2">2 charges</option>
                  <option value="5">5 charges</option>
                  <option value="10">10 charges</option>
                </Select>
              </div>
              <div>
                <FieldLabel htmlFor="q-min-a">Worth at least</FieldLabel>
                <Select id="q-min-a" className="!h-10 !bg-card !text-sm" value={minAmount} onChange={e => setMinAmount(e.target.value)}>
                  <option value="0">Any amount</option>
                  <option value="500">₹500</option>
                  <option value="1000">₹1,000</option>
                  <option value="5000">₹5,000</option>
                  <option value="10000">₹10,000</option>
                </Select>
              </div>
            </div>
          )}
        </div>

        <div ref={listRef} className="max-h-[640px] overflow-y-auto px-3 pb-3">
          {error && !groups ? (
            <div className="p-2">
              <ErrorCard message="The list didn't load. Check that the backend is running, then try again." onRetry={() => mutate()} />
            </div>
          ) : isLoading && !groups ? (
            <ListSkeleton rows={7} />
          ) : filtered.length === 0 ? (
            tagFilter === "untagged" && !search && !extraFilters ? (
              <EmptyState
                compact
                illustration="coin jar with a leaf"
                title="Everything has a tag"
                hint="New statements are tagged by your rules as they come in."
                action={<Button variant="ghost" onClick={() => setTagFilter("all")}>Show everything</Button>}
              />
            ) : (
              <EmptyState
                compact
                illustration="receipt"
                title="Nothing matches"
                hint="Try a shorter search or fewer filters."
                action={
                  <Button variant="ghost" onClick={() => {
                    setSearch(""); setFlowFilter("all"); setCategoryFilter(""); setMinTxns("0"); setMinAmount("0");
                  }}>
                    Clear filters
                  </Button>
                }
              />
            )
          ) : (
            <ul className="space-y-1" aria-label={`${noun} list`}>
              {filtered.slice(0, shown).map(g => {
                const active = g.key === selectedKey;
                return (
                  <li key={g.key}>
                    <button
                      type="button"
                      data-queue-item
                      aria-current={active || undefined}
                      onClick={() => open(g)}
                      className={clsx(
                        "flex w-full items-center gap-3 rounded-m px-3 py-3 text-left transition-colors",
                        active ? "bg-surface" : "hover:bg-surface",
                      )}
                    >
                      <MerchantAvatar name={cleanName(g.label) || g.label} warn={g.uncategorized_count > 0} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-semibold text-ink" title={g.label}>{cleanName(g.label) || g.label}</span>
                        <span className="block truncate text-[13px] font-medium text-muted">
                          {g.uncategorized_count > 0 && g.uncategorized_count < g.txn_count
                            ? `${g.uncategorized_count} of ${g.txn_count} untagged`
                            : g.uncategorized_count > 0
                              ? plural(g.txn_count, "charge")
                              : g.top_category ?? plural(g.txn_count, "charge")}
                        </span>
                      </span>
                      <span className="shrink-0 text-[15px] font-semibold tabular-nums text-ink-2">
                        {inr(g.expense_amount || g.total_amount)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {filtered.length > shown && (
            <div className="flex justify-center pt-3">
              <Button variant="ghost" size="sm" onClick={() => setShown(s => s + PAGE)}>
                Show {Math.min(PAGE, filtered.length - shown)} more
              </Button>
            </div>
          )}
        </div>
        {filtered.length > 0 && (
          <div className="hidden justify-center border-t border-line px-5 py-3 md:flex">
            <ShortcutHint openLabel="open" />
          </div>
        )}
      </Card>

      {/* Selected */}
      <div ref={detailRef} className="scroll-mt-24 lg:col-span-7">
        {selected ? (
          <GroupDetail
            key={selected.key}
            kind={kind}
            noun={noun}
            group={selected}
            defaultKind={inferKindFromCategory(selected.top_category, taxonomy)}
            onMakeRule={onMakeRule}
            onTagged={(msg) => {
              onTagged(msg);
              if (tagFilter === "untagged") selectNextAfter(selected.key);
              mutate();
            }}
          />
        ) : (
          <Card className="hidden lg:block">
            <EmptyState
              illustration="receipt"
              title={totalUntaggedGroups ? `Pick a ${noun} to tag` : "Nothing waiting"}
              hint={totalUntaggedGroups
                ? `Choose one on the left to see its charges and tag them all at once.`
                : `Every ${noun} has a tag. Switch the list to All to change one.`}
            />
          </Card>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Selected counterparty
// ---------------------------------------------------------------------------

function GroupDetail({
  kind, noun, group, defaultKind, onMakeRule, onTagged,
}: {
  kind: GroupKind;
  noun: string;
  group: EnrichedGroup;
  defaultKind: CategoryKind;
  onMakeRule: Props["onMakeRule"];
  onTagged: (message: string) => void;
}) {
  const suggestion = suggestionFor(group);
  const display = cleanName(group.label) || group.label;
  const tagged = group.txn_count - group.uncategorized_count;

  const [catKind, setCatKind] = useState<CategoryKind>(group.income_amount > group.expense_amount ? "income" : defaultKind);
  const [cat, setCat] = useState<string | null>(null);
  const [sub, setSub] = useState<string | null>(null);
  const [subSub, setSubSub] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const txnFilter: TagStatusFilter = "all";
  const [detailId, setDetailId] = useState<string | null>(null);

  const txnFilters = useMemo<TransactionFilters>(() => {
    const base: TransactionFilters = {
      limit: 500,
      sort_by: "date",
      sort_dir: "desc",
      tag_status: txnFilter === "all" ? undefined : txnFilter,
    };
    if (kind === "vpa") base.vpa = group.label;
    else if (kind === "merchant") base.merchant_name = group.label;
    else {
      const { merchant, vpa } = parseCombinedKey(group.key);
      base.merchant_name = group.label.split(" · ")[0]?.trim() || merchant;
      base.vpa = vpa;
    }
    return base;
  }, [group, kind, txnFilter]);

  const { data: txns, error: txnError, isLoading: txnLoading, mutate: refetchTxns } = useTransactions(txnFilters);

  async function apply() {
    if (!cat) return;
    setConfirmOpen(false);
    setBusy(true);
    setError(null);
    try {
      let r: { transactions_updated: number };
      if (kind === "combined") {
        const { merchant, vpa } = parseCombinedKey(group.key);
        r = await bulkApplyCategory({
          kind: "combined",
          vpa_value: vpa,
          merchant_value: group.label.split(" · ")[0]?.trim() || merchant,
          category: cat,
          subcategory: sub || undefined,
          sub_subcategory: subSub || undefined,
        });
      } else {
        r = await bulkApplyCategory({
          kind: kind === "merchant" ? "merchant" : "vpa",
          value: group.label,
          category: cat,
          subcategory: sub || undefined,
          sub_subcategory: subSub || undefined,
        });
      }
      invalidateAll();
      refetchTxns();
      onTagged(`Tagged ${plural(r.transactions_updated, "charge")} from ${display} as ${categoryPath(cat, sub)}. New ones will be too.`);
    } catch (e) {
      setError(`Nothing changed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const target = cat ? categoryPath(cat, sub) : null;
  const actionLabel = cat ? `Tag ${plural(group.txn_count, "charge")} as ${cat}` : "Pick a category to tag these";

  return (
    <Card className="rise-in space-y-6">
      <div className="flex items-start gap-4">
        <MerchantAvatar name={display} warn={group.uncategorized_count > 0} className="!h-12 !w-12 !text-lg" />
        <div className="min-w-0">
          <h2 className="break-words text-[26px] font-black leading-[1.15] text-ink" title={group.label}>{display}</h2>
          <p className="mt-1 text-[15px] text-ink-2">
            {plural(group.txn_count, "charge")}
            {group.expense_amount > 0 && <>, {inr(group.expense_amount)} out</>}
            {group.income_amount > 0 && <>, {inr(group.income_amount)} in</>}
            {group.uncategorized_count > 0 && group.uncategorized_count < group.txn_count && (
              <span className="text-muted">. {group.uncategorized_count} still untagged</span>
            )}
          </p>
        </div>
      </div>

      {suggestion ? (
        <SuggestionBlock
          title={suggestion.category}
          aside={
            <>
              {suggestion.lowConfidence && <Chip tone="warning" size="sm">Not sure, check this</Chip>}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCat(suggestion.category);
                  setSub(null);
                  setSubSub(null);
                }}
              >
                Use {suggestion.category}
              </Button>
            </>
          }
        >
          <WhyThis>
            <p>
              {suggestion.tagged} of the {group.txn_count} charges from {group.label} already have a tag, and{" "}
              {suggestion.category} is the most common one. The other {group.uncategorized_count} have none yet.
              {suggestion.lowConfidence && " That's only a few to go on, so check the charges below before you tag."}
            </p>
            <p className="mt-1.5 text-muted">Nothing changes until you press the tag button.</p>
          </WhyThis>
        </SuggestionBlock>
      ) : null}

      <div>
        <h3 className="mb-3 text-h3 font-black text-ink">Tag {group.txn_count === 1 ? "it" : `all ${group.txn_count}`} as</h3>
        <CategoryPicker
          kind={catKind}
          category={cat}
          subcategory={sub}
          sub_subcategory={subSub}
          showKindToggle
          layout="chips"
          onKindChange={k => { setCatKind(k); setCat(null); setSub(null); setSubSub(null); }}
          onChange={v => { setCat(v.category); setSub(v.subcategory); setSubSub(v.sub_subcategory); }}
        />
      </div>

      {error && <AlertBanner variant="danger">{error}</AlertBanner>}

      <div>
        {busy ? (
          <AiWorking>Tagging {plural(group.txn_count, "charge")} from {group.label} and saving a rule…</AiWorking>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              size="lg"
              disabled={!cat}
              onClick={() => (tagged > 0 ? setConfirmOpen(true) : apply())}
            >
              {actionLabel}
            </Button>
            <button type="button" className="text-link text-sm" onClick={() => setPreviewOpen(true)}>Preview matches</button>
          </div>
        )}
        <p className="mt-3 text-sm font-medium text-muted">
          {target
            ? `New charges from ${display} become ${target} too. `
            : `You only do this once per ${noun}. `}
          <button
            type="button"
            className="text-link"
            onClick={() => onMakeRule(treeFromGroup(kind, group), group.label, cat)}
          >
            Need conditions? Make a custom rule
          </button>
        </p>
      </div>

      <div>
        <h3 className="mb-2 text-[13px] font-semibold text-muted">The charges</h3>
        {txnError && !txns ? (
          <ErrorCard message="These charges didn't load." onRetry={() => refetchTxns()} />
        ) : txnLoading && !txns ? (
          <ListSkeleton rows={3} />
        ) : (txns?.transactions ?? []).length === 0 ? (
          <p className="py-6 text-center text-[15px] text-muted">No charges to show.</p>
        ) : (
          <ul className="-mx-3 max-h-[360px] overflow-y-auto" aria-label={`Charges from ${display}`}>
            {(txns?.transactions ?? []).map(t => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setDetailId(t.id)}
                  className="group flex w-full items-center gap-3 rounded-m px-3 py-2 text-left transition-colors hover:bg-surface"
                >
                  <span className="w-14 shrink-0 text-[13px] font-semibold tabular-nums text-ink-2">{dayMonth(t.date)}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-muted">
                    {needsTag(t)
                      ? <span className="font-semibold text-warning-text">Needs a tag</span>
                      : categoryPath(t.category, t.subcategory) || (t.is_internal_transfer ? "Transfer" : "Card bill")}
                    <span className="hidden font-mono text-[12px] sm:group-hover:inline"> · {t.description}</span>
                  </span>
                  <Amount amount={t.amount} type={t.type} className="text-[15px]" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={`Tag all ${plural(group.txn_count, "charge")} as ${cat ?? ""}?`}
        confirmLabel={actionLabel}
        onConfirm={apply}
        onClose={() => setConfirmOpen(false)}
        note="A rule is saved so new charges follow."
      >
        <p>
          {tagged} of these already {tagged === 1 ? "has" : "have"} a tag
          {group.top_category ? <>, mostly <strong className="font-semibold text-ink">{group.top_category}</strong></> : null}.
          They change to <strong className="font-semibold text-ink">{target}</strong> as well, including any you tagged by hand.
        </p>
      </ConfirmDialog>

      {previewOpen && (
        <RulePreviewDialog
          open
          onClose={() => setPreviewOpen(false)}
          conditions={treeFromGroup(kind, group)}
          title={`What matches ${group.label}`}
        />
      )}

      <TransactionDetailDrawer
        txnId={detailId}
        onClose={() => { setDetailId(null); refetchTxns(); }}
      />
    </Card>
  );
}
