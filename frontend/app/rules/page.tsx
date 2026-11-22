"use client";

// Rules: see and edit the rules that tag things automatically.
// Title → one status sentence → each rule as one plain sentence; details open inline.

import clsx from "clsx";
import { ArrowDown, ArrowUp, ChevronDown, Plus, Search, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import { RuleTransactionsDialog } from "@/components/RuleTransactionsDialog";
import { categoryPath, errorText, plural } from "@/components/ledger/format";
import {
  ConfirmDialog, ListSkeleton, Switch, useJkFocus, useToast,
} from "@/components/ledger/primitives";
import { RuleEditorModal, type RuleEditorSeed } from "@/components/ledger/RuleEditorModal";
import { ruleTitle, ruleWhen } from "@/components/ledger/ruleText";
import {
  AiWorking, AlertBanner, Button, Card, EmptyState, ErrorCard, FilterPill, Input,
  PageHeader, PageSection,
} from "@/components/ui";
import {
  deleteRule, invalidateAll, reorderRules, runRuleEngine, toggleRule, useRuleAnalytics, useRules,
} from "@/lib/api";
import type { CategorizationRule, RunEngineResult } from "@/lib/types";

const PAGE = 50;

export default function RulesPage() {
  const { data: rules, error, isLoading, mutate } = useRules();
  const { data: analytics } = useRuleAnalytics();
  const toast = useToast();

  const [search, setSearch] = useState("");
  const [offOnly, setOffOnly] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [openId, setOpenId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<RunEngineResult | null>(null);

  const [editorSeed, setEditorSeed] = useState<RuleEditorSeed | null>(null);
  const [viewRule, setViewRule] = useState<CategorizationRule | null>(null);
  const [deleting, setDeleting] = useState<CategorizationRule | null>(null);
  const [clearTags, setClearTags] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  useJkFocus(listRef, "[data-rule-row]");

  const { user, system } = useMemo(() => {
    const u: CategorizationRule[] = [];
    const s: CategorizationRule[] = [];
    for (const r of rules ?? []) (r.is_system ? s : u).push(r);
    u.sort((a, b) => a.priority - b.priority || a.id - b.id);
    s.sort((a, b) => a.priority - b.priority);
    return { user: u, system: s };
  }, [rules]);

  const filtering = !!search.trim() || offOnly;

  const matches = (r: CategorizationRule) => {
    if (offOnly && r.enabled) return false;
    const q = search.trim().toLowerCase();
    if (q && ![ruleTitle(r), r.rule_value, r.category, r.subcategory ?? ""].some(v => v.toLowerCase().includes(q))) return false;
    return true;
  };
  const visibleUser = user.filter(matches);
  const visibleSystem = system.filter(matches);

  async function onRun() {
    setRunning(true);
    setActionError(null);
    try {
      const r = await runRuleEngine();
      setLastRun(r);
      invalidateAll();
      mutate();
    } catch (e) {
      setActionError(`The rules didn't run: ${errorText(e)}`);
    } finally {
      setRunning(false);
    }
  }

  async function onToggle(rule: CategorizationRule) {
    setBusyId(rule.id);
    setActionError(null);
    try {
      await toggleRule(rule.id, !rule.enabled);
      mutate();
      toast.show(rule.enabled ? `“${ruleTitle(rule)}” is off. It won't tag new charges.` : `“${ruleTitle(rule)}” is on again.`);
    } catch (e) {
      setActionError(`That rule didn't change: ${errorText(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function move(rule: CategorizationRule, dir: -1 | 1) {
    const ids = user.map(r => r.id);
    const i = ids.indexOf(rule.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setBusyId(rule.id);
    setActionError(null);
    try {
      await reorderRules(ids);
      invalidateAll();
      mutate();
    } catch (e) {
      setActionError(`The order didn't save: ${errorText(e)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      const r = await deleteRule(deleting.id, clearTags);
      invalidateAll();
      mutate();
      toast.show(clearTags && r.rows_cleared
        ? `Deleted “${ruleTitle(deleting)}” and cleared ${plural(r.rows_cleared, "tag")}.`
        : `Deleted “${ruleTitle(deleting)}”. Its charges keep their tags.`);
      setDeleting(null);
      setOpenId(null);
    } catch (e) {
      setActionError(`That rule wasn't deleted: ${errorText(e)}`);
      setDeleting(null);
    } finally {
      setDeleteBusy(false);
    }
  }

  const total = rules?.length ?? 0;
  const active = rules?.filter(r => r.enabled).length ?? 0;

  function row(rule: CategorizationRule, idx: number) {
    const open = openId === rule.id;
        const count = rule.transactions_categorized ?? 0;
    return (
      <li key={rule.id} className={clsx("rounded-m transition-colors", open ? "bg-surface" : "hover:bg-surface")}>
        <div className="flex items-center gap-4 px-4 py-3">
          <Switch
            checked={rule.enabled}
            busy={busyId === rule.id}
            label={rule.enabled ? `Turn off ${ruleTitle(rule)}` : `Turn on ${ruleTitle(rule)}`}
            onChange={() => onToggle(rule)}
          />
          <button
            type="button"
            data-rule-row
            aria-expanded={open}
            onClick={() => setOpenId(open ? null : rule.id)}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-s text-left"
          >
            <RuleSentence rule={rule} />
            <ChevronDown
              className={clsx("h-4 w-4 shrink-0 text-muted transition-transform duration-300", open && "rotate-180")}
              strokeWidth={1.75}
              aria-hidden
            />
          </button>
        </div>

        {open && (
          <div className="rise-in space-y-3 px-4 pb-4 sm:pl-[80px]">
            <p className="text-[15px] leading-relaxed text-ink-2">
              {count > 0
                ? <>Has tagged <button type="button" className="text-link" onClick={() => setViewRule(rule)}>{plural(count, "transaction")}</button>.</>
                : "Nothing carries its tag right now."}
              {!rule.is_system && <> Checked {ordinal(idx + 1)} of {user.length}; when two rules match, the earlier one wins.</>}
              {rule.description && <span className="text-muted"> {rule.description}</span>}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {!rule.is_system && (
                <Button size="sm" onClick={() => setEditorSeed({ rule })}>Edit rule</Button>
              )}
              {!rule.is_system && !filtering && (
                <>
                  <Button variant="ghost" size="sm" disabled={idx === 0 || busyId === rule.id} onClick={() => move(rule, -1)}>
                    <ArrowUp className="h-4 w-4" strokeWidth={1.75} /> Check earlier
                  </Button>
                  <Button variant="ghost" size="sm" disabled={idx >= user.length - 1 || busyId === rule.id} onClick={() => move(rule, 1)}>
                    <ArrowDown className="h-4 w-4" strokeWidth={1.75} /> Check later
                  </Button>
                </>
              )}
              {!rule.is_system && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="sm:ml-auto"
                  onClick={() => { setClearTags(false); setDeleting(rule); }}
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.75} /> Delete
                </Button>
              )}
              {rule.is_system && <p className="text-sm text-muted">Built in. You can turn it off but not delete it.</p>}
            </div>
          </div>
        )}
      </li>
    );
  }

  return (
    <PageSection className="space-y-6">
      {/* Actions sit beside the title on desktop and under it on phones. */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0 flex-1">
        <PageHeader
          title="See and edit the rules that tag for you"
          description={
            rules && rules.length > 0 ? (
              <>
                {active === total ? `${plural(total, "rule")} tag new charges for you` : `${active} of ${plural(total, "rule")} are on`}
                {analytics ? <>, {analytics.transactions_by_rules.toLocaleString("en-IN")} so far</> : null}.
                Tags you set by hand always win.
              </>
            ) : "Rules tag new statements for you, so you only tag a merchant once."
          }
        />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
            <Button variant="ghost" onClick={onRun} disabled={running || !total}>Run on untagged</Button>
            <Button variant="primary" onClick={() => setEditorSeed({})}>
              <Plus className="h-4 w-4" strokeWidth={1.75} /> Create rule
            </Button>
        </div>
      </div>

      {running && <AiWorking>Running {plural(active, "rule")} over your untagged charges…</AiWorking>}
      {lastRun && !running && (
        <AlertBanner variant="success" onDismiss={() => setLastRun(null)}>
          Checked {plural(lastRun.scanned, "untagged charge")} and tagged {lastRun.matched}.
          {(lastRun.cleared ?? 0) > 0 && <> Cleared {plural(lastRun.cleared ?? 0, "out-of-date tag")}.</>}
        </AlertBanner>
      )}
      {actionError && <AlertBanner variant="danger" onDismiss={() => setActionError(null)}>{actionError}</AlertBanner>}

      <Card padded={false}>
        <div className="flex items-center gap-3 p-5 pb-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" strokeWidth={1.75} />
            <Input
              type="search"
              aria-label="Search rules"
              placeholder="Search rules"
              value={search}
              onChange={e => { setSearch(e.target.value); setShown(PAGE); }}
              className="pl-12"
            />
          </div>
          <FilterPill label="Off only" active={offOnly} onClick={() => setOffOnly(o => !o)} />
        </div>

        <div ref={listRef} className="px-3 pb-3">
          {error && !rules ? (
            <div className="p-2">
              <ErrorCard message="Your rules didn't load. Check that the backend is running, then try again." onRetry={() => mutate()} />
            </div>
          ) : isLoading && !rules ? (
            <ListSkeleton rows={6} />
          ) : total === 0 ? (
            <EmptyState
              illustration="piggy bank"
              title="No rules yet"
              hint="Tag a counterparty on Categorise and a rule is saved for you. Or create one with your own conditions."
              action={<Link href="/categorize" className="btn ghost">Go to Categorise</Link>}
            />
          ) : visibleUser.length + visibleSystem.length === 0 ? (
            <EmptyState
              compact
              illustration="receipt"
              title="No rules match"
              hint="Try another search."
              action={<Button variant="ghost" onClick={() => { setSearch(""); setOffOnly(false); }}>Clear filters</Button>}
            />
          ) : (
            <>
              <ul className="space-y-1" aria-label="Your rules">
                {visibleUser.slice(0, shown).map(r => row(r, user.indexOf(r)))}
              </ul>
              {visibleUser.length > shown && (
                <div className="flex justify-center pt-3">
                  <Button variant="ghost" size="sm" onClick={() => setShown(s => s + PAGE)}>
                    Show {Math.min(PAGE, visibleUser.length - shown)} more
                  </Button>
                </div>
              )}
              {visibleSystem.length > 0 && (
                <>
                  <p className="px-4 pb-1 pt-5 text-[13px] font-semibold text-muted">Built in</p>
                  <ul className="space-y-1" aria-label="Built-in rules">
                    {visibleSystem.map(r => row(r, -1))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </Card>

      <RuleEditorModal
        open={!!editorSeed}
        seed={editorSeed}
        onClose={() => setEditorSeed(null)}
        onSaved={msg => { toast.show(msg); mutate(); }}
      />

      <RuleTransactionsDialog rule={viewRule} onClose={() => setViewRule(null)} />

      <ConfirmDialog
        open={!!deleting}
        title={`Delete “${deleting ? ruleTitle(deleting) : ""}”?`}
        confirmLabel="Delete rule"
        tone="danger"
        busy={deleteBusy}
        onConfirm={confirmDelete}
        onClose={() => setDeleting(null)}
        note="This can't be undone."
      >
        <p>New statements won&apos;t be tagged by it any more.</p>
        {(deleting?.transactions_categorized ?? 0) > 0 && (
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={clearTags}
              onChange={e => setClearTags(e.target.checked)}
              className="mt-1 h-4 w-4 accent-accent-600"
            />
            <span>
              Also remove its tag from the {plural(deleting?.transactions_categorized ?? 0, "transaction")} it tagged,
              so they show up as untagged again
            </span>
          </label>
        )}
      </ConfirmDialog>

      {toast.node}
    </PageSection>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** "When paid to swiggy@icici, tag as Food › Delivery." */
function RuleSentence({ rule }: { rule: CategorizationRule }) {
  const { lead, value } = ruleWhen(rule);
  const strong = rule.enabled ? "font-semibold text-ink" : "font-semibold text-muted";
  return (
    <span className={clsx("line-clamp-3 min-w-0 flex-1 text-[15px] leading-snug sm:line-clamp-2", rule.enabled ? "text-ink-2" : "text-muted")}>
      {lead}
      {value && <> <span className={clsx(strong, "break-words")}>{value}</span></>}
      , tag as <span className={strong}>{categoryPath(rule.category, rule.subcategory)}</span>
    </span>
  );
}
