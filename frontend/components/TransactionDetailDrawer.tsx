"use client";

// Right-side drawer with the full transaction and everything needed to fix
// how it's counted: its category (with how it got that category), whether
// it's a transfer or a card bill, and the raw statement fields.
//
// White, 28px radius, floating shadow (design.md §5.3, §7). Sections are
// quiet surface blocks and every edit happens inline.

import clsx from "clsx";
import { ArrowLeftRight, CreditCard, Link2Off, SplitSquareHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { CategoryPicker } from "@/components/CategoryPicker";
import { categoryPath, errorText, fullDate } from "@/components/ledger/format";
import {
  Amount, QuietBlock, SuggestionBlock, WhyThis, needsTag,
} from "@/components/ledger/primitives";
import { txnName } from "@/components/ledger/merchant";
import { MerchantAvatar } from "@/components/ledger/TxnList";
import { conditionsText, ruleTitle } from "@/components/ledger/ruleText";
import {
  AlertBanner, Button, Chip, ErrorCard, IconButton, Input, Label, Modal, Select, Skeleton,
} from "@/components/ui";
import {
  getCCPaymentCandidates, getTransferCandidates, invalidateAll,
  linkInternalTransfer, markCCPayment, patchTransaction, unlinkCCPayment,
  unlinkInternalTransfer, useRules, useTaxonomy, useTransactionDetail,
} from "@/lib/api";
import { inr } from "@/lib/format";
import type {
  CategorizationRule, CategorizationSource, CategoryKind, CCPaymentCandidate, Transaction,
  TransferCandidate,
} from "@/lib/types";
import { REFUND_SUBTYPES } from "@/lib/types";

// ---------------------------------------------------------------------------
// Where a category came from, in plain words.
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<CategorizationSource, string> = {
  manual:           "Tagged by you",
  excel_import:     "From your spreadsheet",
  vpa_mapping:      "VPA rule",
  merchant_mapping: "Merchant rule",
  keyword_rule:     "Keyword rule",
  rule_engine:      "Custom rule",
  auto_income:      "Income, tagged automatically",
  ai:               "Suggested by AI",
};

/** Small neutral chip naming where a category came from. */
export function CategorizationSourceChip({
  source, ruleName,
}: {
  source: CategorizationSource | null | undefined;
  ruleName?: string | null;
}) {
  if (!source || !SOURCE_LABEL[source]) return null;
  return (
    <Chip size="sm" title={ruleName ? `${SOURCE_LABEL[source]}: ${ruleName}` : SOURCE_LABEL[source]}>
      {ruleName ? `${SOURCE_LABEL[source]}: ${ruleName}` : SOURCE_LABEL[source]}
    </Chip>
  );
}

function sourceReason(t: Transaction, rule: CategorizationRule | undefined): string {
  const tag = categoryPath(t.category, t.subcategory, t.sub_subcategory);
  if (t.categorized_by_rule_id && !rule && t.categorization_source !== "manual") {
    return `A rule that has since been deleted tagged this ${tag}. Change it below if it's wrong.`;
  }
  switch (t.categorization_source) {
    case "vpa_mapping":
      return `Your rule “${rule ? ruleTitle(rule) : t.categorized_by_rule_name}” tags every payment to ${rule?.rule_value ?? "this VPA"} as ${rule?.category ?? tag}. This charge went to ${t.vpa ?? "that VPA"}, so it matched.`;
    case "merchant_mapping":
      return `Your rule “${rule ? ruleTitle(rule) : t.categorized_by_rule_name}” tags every charge from ${rule?.rule_value ?? "this merchant"} as ${rule?.category ?? tag}. The statement names the merchant as ${t.merchant_name ?? "the same"}, so it matched.`;
    case "keyword_rule":
      return `Your rule “${rule ? ruleTitle(rule) : t.categorized_by_rule_name}” tags anything whose description contains “${rule?.rule_value ?? "its keyword"}”. This description does.`;
    case "rule_engine": {
      const cond = rule ? conditionsText(rule.conditions) : "";
      return `Your rule “${rule ? ruleTitle(rule) : t.categorized_by_rule_name ?? "custom rule"}” matched${cond ? ` because ${cond}` : ""}.`;
    }
    case "auto_income":
      return "Credits that look like salary, interest or refunds are tagged as income when a statement is read, so they don't wait in the untagged list.";
    case "excel_import":
      return "This tag came from a spreadsheet you filled in and uploaded on the Categorise page.";
    case "ai":
      return "An AI model suggested this tag from the description. No rule backs it, so it's worth a check.";
    default:
      return "";
  }
}

/** How this transaction got its category (§11.1, §11.3, §11.7). */
function SourceExplainer({ t }: { t: Transaction }) {
  const { data: rules } = useRules();
  const rule = useMemo(
    () => rules?.find(r => r.id === t.categorized_by_rule_id),
    [rules, t.categorized_by_rule_id],
  );

  if (!t.category) {
    return <p className="text-sm font-medium text-warning-text">Nothing has tagged this yet. Pick one below.</p>;
  }
  if (!t.categorization_source || t.categorization_source === "manual") {
    return (
      <p className="text-sm text-muted">
        <span className="font-semibold text-ink">{categoryPath(t.category, t.subcategory, t.sub_subcategory)}</span>
        {" "}· Tagged by you. Rules never overwrite your own tags.
      </p>
    );
  }

  const source = SOURCE_LABEL[t.categorization_source] ?? "Automatic";
  const ruleName = rule ? ruleTitle(rule) : t.categorized_by_rule_name;
  return (
    <SuggestionBlock
      eyebrow="Tagged automatically"
      title={categoryPath(t.category, t.subcategory, t.sub_subcategory)}
      aside={
        t.categorization_source === "ai"
          ? <Chip tone="warning" size="sm">Not sure, check this</Chip>
          : <Chip tone="accent" size="sm">{ruleName ? `${source}: ${ruleName}` : source}</Chip>
      }
    >
      <WhyThis>
        <p>{sourceReason(t, rule)}</p>
        <p className="mt-1.5 text-muted">Change it below and your edit wins over any rule.</p>
      </WhyThis>
    </SuggestionBlock>
  );
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

type DialogMode = null | "internal-transfer" | "cc-payment";

export function TransactionDetailDrawer({
  txnId,
  onClose,
  onConvertEmi,
}: {
  txnId: string | null;
  onClose: () => void;
  /** Optional: offer "Spread as an EMI" for debits. */
  onConvertEmi?: (t: Transaction) => void;
}) {
  const { data, isLoading, error, mutate } = useTransactionDetail(txnId);
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [flagBusy, setFlagBusy] = useState(false);
  const [flagError, setFlagError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  // Escape closes the drawer unless a dialog sits on top of it.
  useEffect(() => {
    if (!txnId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (dialog || document.querySelectorAll('[aria-modal="true"]').length > 1) return;
      onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [txnId, dialog, onClose]);

  // Focus in on open, back to where you were on close; lock page scroll.
  useEffect(() => {
    if (!txnId) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
      restoreFocus.current?.focus?.({ preventScroll: true });
    };
  }, [txnId]);

  useEffect(() => { setFlagError(null); }, [txnId]);

  if (!txnId) return null;
  const t = data?.transaction;

  async function runFlag(fn: () => Promise<unknown>) {
    setFlagBusy(true);
    setFlagError(null);
    try {
      await fn();
      invalidateAll();
      mutate();
    } catch (e) {
      setFlagError(errorText(e));
    } finally {
      setFlagBusy(false);
    }
  }

  if (typeof document === "undefined") return null;
  // Portal to <body> so the drawer sits above the sticky top bar, whatever
  // stacking context the page content is in.
  return createPortal(
    <div className="fixed inset-0 z-[45]" role="dialog" aria-modal="true" aria-label="Transaction">
      <div className="drawer-backdrop absolute inset-0 bg-black/40 backdrop-blur-[4px]" onClick={onClose} />
      <aside
        ref={panelRef}
        tabIndex={-1}
        className="drawer-panel absolute inset-y-0 right-0 flex w-full flex-col overflow-hidden bg-card shadow-float sm:inset-y-3 sm:right-3 sm:max-w-[560px] sm:rounded-l focus:outline-none"
      >
        {/* Header */}
        <header className="px-6 pb-5 pt-6 sm:px-7 sm:pt-7">
          <div className="flex items-start justify-between gap-4">
            <p className="pt-2 text-[13px] font-semibold text-muted">
              {t ? `${fullDate(t.date)} · ${t.account_name}` : "Transaction"}
            </p>
            <IconButton size="sm" onClick={onClose} aria-label="Close" className="shrink-0">
              <X className="h-4 w-4" strokeWidth={1.75} />
            </IconButton>
          </div>
          {t ? (
            <>
              <div className="mt-3 flex items-center gap-4">
                <MerchantAvatar name={txnName(t)} warn={needsTag(t)} className="!h-12 !w-12 !text-lg" />
                <div className="min-w-0">
                  <h2 className="line-clamp-2 break-words text-[26px] font-black leading-[1.15] tracking-[-0.005em] text-ink">
                    {txnName(t)}
                  </h2>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-2">
                <Amount amount={t.amount} type={t.type} className="text-[32px] !font-black leading-none tracking-[-0.01em]" />
                <span className="text-sm font-medium text-muted">
                  {t.type === "debit" ? "Money out" : "Money in"}{t.txn_mode ? ` by ${t.txn_mode}` : ""}
                </span>
              </div>
            </>
          ) : isLoading ? (
            <div aria-busy="true" aria-label="Loading">
              <Skeleton className="mt-3 h-7 w-3/4" />
              <Skeleton className="mt-4 h-8 w-40" />
            </div>
          ) : null}
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 pb-8 sm:px-7">
          {error && !t && (
            <ErrorCard
              message="This transaction didn't load. Check that the backend is running, then try again."
              onRetry={() => mutate()}
            />
          )}

          {isLoading && !t && (
            <div className="space-y-4" aria-hidden>
              <Skeleton className="h-48 w-full !rounded-m" />
              <Skeleton className="h-32 w-full !rounded-m" />
            </div>
          )}

          {t && (
            <>
              <CategorizationSection
                key={`${t.id}:${t.category}:${t.subcategory}:${t.sub_subcategory}:${t.is_refund}`}
                transaction={t}
                onSaved={() => { invalidateAll(); mutate(); }}
              />

              <QuietBlock title="How it's counted">
                <p className="text-[15px] leading-relaxed text-ink-2">{countedSentence(t, !!data?.cc_bill_link)}</p>

                {data?.linked_transaction && (
                  <div className="mt-3">
                    <p className="mb-1.5 text-[13px] font-semibold text-muted">The other side of this transfer</p>
                    <LinkedRow other={data.linked_transaction} />
                  </div>
                )}
                {data?.cc_bill_link && (
                  <div className="mt-3 rounded-s bg-card p-4">
                    <p className="font-semibold text-ink">{data.cc_bill_link.cc_account_name}</p>
                    <p className="mt-0.5 text-sm text-muted">
                      Bill for {data.cc_bill_link.billing_month} · statement total {inr(data.cc_bill_link.total_amount)}
                    </p>
                  </div>
                )}

                {flagError && <p role="alert" className="mt-3 text-sm font-medium text-danger-text">{flagError}</p>}

                <div className="mt-4 flex flex-wrap gap-2">
                  {t.is_internal_transfer ? (
                    <Button variant="ghost" size="sm" disabled={flagBusy} onClick={() => runFlag(() => unlinkInternalTransfer(t.id))}>
                      <Link2Off className="h-4 w-4" strokeWidth={1.75} /> Count it again
                    </Button>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => setDialog("internal-transfer")}>
                      <ArrowLeftRight className="h-4 w-4" strokeWidth={1.75} /> Mark as a transfer
                    </Button>
                  )}

                  {t.account_type === "savings" && t.type === "debit" && (
                    data?.cc_bill_link ? (
                      <Button variant="ghost" size="sm" disabled={flagBusy} onClick={() => runFlag(() => unlinkCCPayment(t.id))}>
                        <Link2Off className="h-4 w-4" strokeWidth={1.75} /> Not a card bill
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => setDialog("cc-payment")}>
                        <CreditCard className="h-4 w-4" strokeWidth={1.75} /> Mark as a card bill
                      </Button>
                    )
                  )}

                  {onConvertEmi && t.type === "debit" && (
                    <Button variant="ghost" size="sm" onClick={() => onConvertEmi(t)}>
                      <SplitSquareHorizontal className="h-4 w-4" strokeWidth={1.75} />
                      {t.is_emi ? "Change EMI plan" : "Spread as an EMI"}
                    </Button>
                  )}
                </div>
              </QuietBlock>

              <QuietBlock title="From the statement">
                <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink">{t.description}</p>
                {t.raw_text && t.raw_text !== t.description && (
                  <p className="mt-2 whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-muted">
                    {t.raw_text}
                  </p>
                )}
                <button
                  type="button"
                  className="text-link mt-3 text-sm"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen(o => !o)}
                >
                  {moreOpen ? "Fewer details" : "Account, VPA and reference"}
                </button>
                {moreOpen && <dl className="rise-in mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <Field label="Account">{t.account_name} · {t.account_type === "credit_card" ? "Credit card" : "Savings"}</Field>
                  <Field label="Balance after">{t.balance == null ? "Not on statement" : inr(t.balance)}</Field>
                  <Field label="Counterparty">{t.merchant_name || "Not found"}</Field>
                  <Field label="VPA" mono>{t.vpa || "None"}</Field>
                  <Field label="Mode">{t.txn_mode || "Not on statement"}</Field>
                  <Field label="Reference" mono>{t.reference_id || "None"}</Field>
                  <Field label="Source file" className="col-span-2" mono>{t.source_file || "Unknown"}</Field>
                </dl>}
              </QuietBlock>
            </>
          )}
        </div>

        {dialog === "internal-transfer" && t && (
          <InternalTransferDialog
            transaction={t}
            onClose={() => setDialog(null)}
            onLinked={() => { setDialog(null); invalidateAll(); mutate(); }}
          />
        )}
        {dialog === "cc-payment" && t && (
          <CCPaymentDialog
            transaction={t}
            onClose={() => setDialog(null)}
            onLinked={() => { setDialog(null); invalidateAll(); mutate(); }}
          />
        )}
      </aside>
      <style>{`
        .drawer-backdrop { animation: fh-dr-fade .2s var(--soft) both; }
        .drawer-panel { animation: fh-dr-in .5s var(--spring) both; }
        @keyframes fh-dr-fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes fh-dr-in { from { opacity: 0; transform: translateX(24px) } to { opacity: 1; transform: translateX(0) } }
      `}</style>
    </div>,
    document.body,
  );
}

function countedSentence(t: Transaction, hasBill: boolean): string {
  if (t.is_internal_transfer) return "Left out of spending and income: it's money moving between your own accounts.";
  if (t.is_credit_card_payment || hasBill) return "Left out of spending: it pays a card bill, and the purchases on that card are already counted.";
  if (t.is_emi) return "Spread over monthly instalments, so each month shows its share instead of the full amount.";
  if (t.is_refund) return `Counted as money back, which lowers your ${t.refund_category || t.category || "spending"} total.`;
  return t.type === "debit" ? "Counted as spending." : "Counted as income.";
}

// ---------------------------------------------------------------------------
// Internal transfer: pick the matching leg in another account.
// ---------------------------------------------------------------------------

function InternalTransferDialog({
  transaction, onClose, onLinked,
}: {
  transaction: Transaction;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [candidates, setCandidates] = useState<TransferCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoadError(null);
    setCandidates(null);
    getTransferCandidates(transaction.id)
      .then(setCandidates)
      .catch(e => setLoadError(errorText(e)));
  }
  useEffect(load, [transaction.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const link = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await linkInternalTransfer(transaction.id, picked);
      onLinked();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Mark as a transfer"
      width="max-w-[600px]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={link} loading={busy} disabled={!picked}>Link as a transfer</Button>
          <p className="w-full text-right text-sm font-medium text-muted">
            Both sides drop out of spending and income. You can undo it from either side.
          </p>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[15px] leading-relaxed text-ink-2">
          Pick the other side of this transfer. These are opposite-direction entries in your other accounts
          within ₹10 and 7 days of{" "}
          <span className="font-semibold text-ink">
            {transaction.type === "debit" ? "−" : "+"}{inr(transaction.amount)} on {fullDate(transaction.date)}
          </span>.
        </p>

        {error && <AlertBanner variant="danger">That link didn&apos;t save: {error}</AlertBanner>}
        {loadError && <ErrorCard message={`The matches didn't load: ${loadError}`} onRetry={load} />}
        {!candidates && !loadError && (
          <div className="space-y-2" aria-busy="true" aria-label="Loading matches">
            <Skeleton className="h-[72px] w-full !rounded-m" />
            <Skeleton className="h-[72px] w-full !rounded-m" />
          </div>
        )}
        {candidates && candidates.length === 0 && (
          <AlertBanner variant="warning">
            No matching entry found. Upload the other account&apos;s statement for the same dates, then try again.
          </AlertBanner>
        )}
        {candidates && candidates.length > 0 && (
          <ul className="max-h-80 space-y-1.5 overflow-y-auto" role="radiogroup" aria-label="Matching entries">
            {candidates.map(c => (
              <li key={c.id}>
                <label
                  className={clsx(
                    "flex cursor-pointer items-start gap-3 rounded-m p-4 transition-colors",
                    picked === c.id ? "bg-surface shadow-[inset_0_0_0_1.5px_var(--accent-500)]" : "hover:bg-surface",
                  )}
                >
                  <input
                    type="radio"
                    name="partner"
                    checked={picked === c.id}
                    onChange={() => setPicked(c.id)}
                    className="mt-1 accent-accent-600"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-extrabold text-ink">{c.account_name}</span>
                      <Amount amount={c.amount} type={c.type} />
                      <span className="text-sm text-muted">{fullDate(c.date)}</span>
                      {c.amount_diff === 0 && c.day_diff === 0 && <Chip tone="success" size="sm">Exact match</Chip>}
                    </div>
                    <p className="mt-1 truncate text-sm text-muted" title={c.description}>{c.description}</p>
                    {(c.amount_diff !== 0 || c.day_diff !== 0) && (
                      <p className="mt-0.5 text-[13px] text-muted">
                        {inr(Math.abs(c.amount_diff))} apart · {Math.abs(c.day_diff)} {Math.abs(c.day_diff) === 1 ? "day" : "days"} apart
                      </p>
                    )}
                  </div>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Card bill: link a savings debit to a credit-card statement.
// ---------------------------------------------------------------------------

function CCPaymentDialog({
  transaction, onClose, onLinked,
}: {
  transaction: Transaction;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [candidates, setCandidates] = useState<CCPaymentCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [account, setAccount] = useState("");
  const [month, setMonth] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoadError(null);
    setCandidates(null);
    getCCPaymentCandidates(transaction.id)
      .then(c => {
        setCandidates(c);
        if (c.length) {
          setAccount(c[0].cc_account_name);
          setMonth(c[0].billing_month);
        }
      })
      .catch(e => setLoadError(errorText(e)));
  }
  useEffect(load, [transaction.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const link = async () => {
    if (!account || !month) return;
    setBusy(true);
    setError(null);
    try {
      await markCCPayment(transaction.id, account, month);
      onLinked();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Mark as a card bill"
      width="max-w-[600px]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={link} loading={busy} disabled={!account || !month}>
            Link to {account || "card"} bill
          </Button>
          <p className="w-full text-right text-sm font-medium text-muted">
            This payment drops out of spending. The card&apos;s purchases stay counted.
          </p>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[15px] leading-relaxed text-ink-2">
          This {inr(transaction.amount)} from <span className="font-semibold text-ink">{transaction.account_name}</span>{" "}
          paid a credit-card bill. Link it to that bill so the same rupee isn&apos;t counted twice.
        </p>

        {error && <AlertBanner variant="danger">That link didn&apos;t save: {error}</AlertBanner>}
        {loadError && <ErrorCard message={`Suggested bills didn't load: ${loadError}`} onRetry={load} />}
        {!candidates && !loadError && (
          <div className="space-y-2" aria-busy="true" aria-label="Loading bills">
            <Skeleton className="h-14 w-full !rounded-m" />
            <Skeleton className="h-14 w-full !rounded-m" />
          </div>
        )}

        {candidates && candidates.length > 0 && (
          <div>
            <p className="mb-2 text-[13px] font-semibold text-muted">Bills within 5% of this payment</p>
            <ul className="space-y-1.5" role="radiogroup" aria-label="Suggested bills">
              {candidates.map((c, i) => {
                const on = account === c.cc_account_name && month === c.billing_month;
                return (
                  <li key={i}>
                    <label
                      className={clsx(
                        "flex cursor-pointer items-center gap-3 rounded-m px-4 py-3 transition-colors",
                        on ? "bg-surface shadow-[inset_0_0_0_1.5px_var(--accent-500)]" : "hover:bg-surface",
                      )}
                    >
                      <input
                        type="radio"
                        name="ccpay"
                        checked={on}
                        onChange={() => { setAccount(c.cc_account_name); setMonth(c.billing_month); }}
                        className="accent-accent-600"
                      />
                      <span className="font-extrabold text-ink">{c.cc_account_name}</span>
                      <span className="text-sm text-muted">{c.billing_month}</span>
                      <span className="ml-auto font-semibold tabular-nums text-ink">{inr(c.total_amount)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {candidates && candidates.length === 0 && (
          <p className="text-sm text-muted">No card bill is close to this amount. Enter the card and month yourself.</p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="cc-acct">Card account</Label>
            <Input id="cc-acct" value={account} onChange={e => setAccount(e.target.value)} placeholder="SBI_CC" />
          </div>
          <div>
            <Label htmlFor="cc-month">Bill month (YYYY-MM)</Label>
            <Input id="cc-month" value={month} onChange={e => setMonth(e.target.value)} placeholder="2026-04" />
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Category + refund editor
// ---------------------------------------------------------------------------

function CategorizationSection({
  transaction, onSaved,
}: {
  transaction: Transaction;
  onSaved: () => void;
}) {
  const [category, setCategory]             = useState(transaction.category ?? "");
  const [subcategory, setSubcategory]       = useState(transaction.subcategory ?? "");
  const [subSubcategory, setSubSubcategory] = useState(transaction.sub_subcategory ?? "");
  const [isRefund, setIsRefund]             = useState(transaction.is_refund);
  const [refundCategory, setRefundCategory] = useState(transaction.refund_category ?? "");
  // Off by default so fixing one row never re-tags the whole counterparty by surprise.
  const [propagate, setPropagate]           = useState(false);
  const [busy, setBusy]                     = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [saved, setSaved]                   = useState(false);

  // credit + not refund → income tree; refunds and debits → expense tree.
  const [kind, setKind] = useState<CategoryKind>(() =>
    transaction.type === "credit" && !transaction.is_refund ? "income" : "expense",
  );
  useEffect(() => {
    if (category) return;
    if (transaction.type === "credit") setKind(isRefund ? "expense" : "income");
  }, [isRefund, category, transaction.type]);

  const { data: taxonomy } = useTaxonomy();
  const expenseRoots = useMemo(() => taxonomy?.expense.filter(r => !r.archived) ?? [], [taxonomy]);

  const dirty =
    (category       || null) !== (transaction.category        ?? null) ||
    (subcategory    || null) !== (transaction.subcategory     ?? null) ||
    (subSubcategory || null) !== (transaction.sub_subcategory ?? null) ||
    isRefund                 !== transaction.is_refund                 ||
    (refundCategory || null) !== (transaction.refund_category ?? null);

  const signal = transaction.vpa || transaction.merchant_name;

  function reset() {
    setCategory(transaction.category ?? "");
    setSubcategory(transaction.subcategory ?? "");
    setSubSubcategory(transaction.sub_subcategory ?? "");
    setIsRefund(transaction.is_refund);
    setRefundCategory(transaction.refund_category ?? "");
    setPropagate(false);
    setError(null);
  }

  async function save() {
    setError(null);
    if (isRefund && transaction.type !== "credit") {
      setError("Only money coming in can be a refund.");
      return;
    }
    if (isRefund && !refundCategory && !category) {
      setError("Pick the category this refund gives money back to.");
      return;
    }
    setBusy(true);
    try {
      await patchTransaction(transaction.id, {
        category:        category || null,
        subcategory:     isRefund ? (subcategory || "Other") : (subcategory || null),
        sub_subcategory: subSubcategory || null,
        is_refund:       isRefund,
        refund_category: isRefund ? (refundCategory || category || null) : null,
        propagate_via:   propagate
          ? (transaction.vpa ? "vpa" : transaction.merchant_name ? "merchant" : null)
          : null,
      });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(`That didn't save: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <QuietBlock title="Category">
      <div className="space-y-5">
        <SourceExplainer t={transaction} />

        {saved && !dirty && (
          <p role="status" className="rise-in text-sm font-semibold text-success-text">Saved.</p>
        )}

        <CategoryPicker
          layout="chips"
          compact
          kind={kind}
          category={category || null}
          subcategory={subcategory || null}
          sub_subcategory={subSubcategory || null}
          onChange={v => {
            setSaved(false);
            setCategory(v.category ?? "");
            setSubcategory(v.subcategory ?? "");
            setSubSubcategory(v.sub_subcategory ?? "");
          }}
          showKindToggle={transaction.type === "credit"}
          onKindChange={k => {
            setKind(k);
            setCategory("");
            setSubcategory("");
            setSubSubcategory("");
          }}
        />

        {transaction.type === "credit" && (
          <div className="rounded-s bg-card p-4">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={isRefund}
                onChange={e => { setSaved(false); setIsRefund(e.target.checked); }}
                className="mt-1 h-4 w-4 accent-accent-600"
              />
              <span>
                <span className="block font-semibold text-ink">This is a refund</span>
                <span className="mt-0.5 block text-sm text-muted">
                  Cashback, a payback from a friend or a vendor refund. It lowers spending in a category instead
                  of counting as income.
                </span>
              </span>
            </label>
            {isRefund && (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="refund-type">Kind of refund</Label>
                  <Select id="refund-type" value={subcategory || "Other"} onChange={e => setSubcategory(e.target.value)}>
                    {REFUND_SUBTYPES.map(s => <option key={s} value={s}>{s}</option>)}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="refund-cat">Gives money back to</Label>
                  <Select id="refund-cat" value={refundCategory || ""} onChange={e => setRefundCategory(e.target.value)}>
                    <option value="">Same as the category above</option>
                    {expenseRoots.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
                  </Select>
                </div>
              </div>
            )}
          </div>
        )}

        {signal && category && (
          <label className="flex cursor-pointer items-start gap-3 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={propagate}
              onChange={e => setPropagate(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-accent-600"
            />
            <span>
              Also save a rule for{" "}
              <span className="rounded-pill bg-card px-2 py-0.5 font-mono text-[12px] text-ink">{signal}</span>
              {" "}so its future charges get this tag too.
            </span>
          </label>
        )}

        {error && <p role="alert" className="text-sm font-medium text-danger-text">{error}</p>}

        <div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {dirty && (
              <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>Undo changes</Button>
            )}
            <Button variant="primary" size="md" onClick={save} loading={busy} disabled={!dirty}>
              {category ? `Save as ${category}` : "Save category"}
            </Button>
          </div>
          {dirty && (
            <p className="mt-2 text-right text-sm font-medium text-muted">
              {propagate && signal
                ? `Also tags future charges from ${signal}.`
                : "Only this transaction changes."}
            </p>
          )}
        </div>
      </div>
    </QuietBlock>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Field({
  label, children, className, mono,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  mono?: boolean;
}) {
  return (
    <div className={clsx("min-w-0", className)}>
      <dt className="text-[13px] font-semibold text-muted">{label}</dt>
      <dd className={clsx("mt-0.5 break-words text-ink", mono && "font-mono text-[12px]")}>{children}</dd>
    </div>
  );
}

function LinkedRow({ other }: { other: Transaction }) {
  return (
    <div className="rounded-s bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-extrabold text-ink">{other.account_name}</span>
        <Amount amount={other.amount} type={other.type} />
        <span className="text-sm text-muted">{fullDate(other.date)}</span>
      </div>
      <p className="mt-1 truncate text-sm text-muted" title={other.description}>{other.description}</p>
    </div>
  );
}
