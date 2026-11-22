"use client";

/*
 * Upload: "Bring in statements." One dropzone, one result list, history
 * tucked away, then a hand-entry card for what statements can't see. Design: design.md §7 Dropzone, §11.6 progress in words,
 * §15 states, §16 test data mode, §17 error copy.
 */

import clsx from "clsx";
import { FileText, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AiWorking, AlertBanner, Button, Card, CardTitle, Chip, ErrorCard, IconButton,
  IllustrationSlot, Input, Label, Modal, PageHeader, Select, Skeleton,
} from "@/components/ui";
import {
  invalidateAll, resetSystem, uploadFiles, useUploadHistory, type ResetSummary,
} from "@/lib/api";
import ManualEntry from "@/components/wealth/ManualEntry";
import { useDataMode } from "@/lib/dataMode";
import type { UploadResult } from "@/lib/types";

const BANKS: Record<string, string> = {
  sbi: "SBI",
  sbi_cc: "SBI Card",
  slice: "slice",
  slice_cc: "slice card",
  canara: "Canara",
};

const FORCE_OPTIONS = [
  { value: "", label: "Work it out for me" },
  { value: "sbi", label: "SBI savings" },
  { value: "sbi_cc", label: "SBI Card" },
  { value: "slice", label: "slice savings" },
  { value: "slice_cc", label: "slice card" },
  { value: "canara", label: "Canara savings" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

const n = (v: number) => (v ?? 0).toLocaleString("en-IN");
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const bankName = (b: string | null | undefined) => (b ? BANKS[b] ?? b : "Unknown bank");

// ---------------------------------------------------------------------------
// What happened to each file, in plain words (§17).
// ---------------------------------------------------------------------------

type Outcome = {
  kind: "added" | "nothing_new" | "already" | "partial" | "password" | "unsupported" | "failed";
  chip: { label: string; tone: "success" | "neutral" | "warning" | "danger" };
  line: string;
  fix?: string;
  retry: boolean;
};

function outcomeOf(r: UploadResult): Outcome {
  const errors = r.errors ?? [];
  const parsed = r.parsed_count ?? 0;
  const fresh = r.new_count ?? 0;
  const dup = r.duplicate_count ?? 0;
  const counts = `${plural(parsed, "transaction")}, ${n(dup)} already here`;

  if (r.skipped_already_uploaded) {
    return { kind: "already", chip: { label: "Already uploaded", tone: "neutral" }, line: "You uploaded this file before, so it was skipped.", retry: false };
  }
  if (errors.length && parsed === 0) {
    const text = errors.join(" ").toLowerCase();
    if (/password|encrypt|decrypt/.test(text)) {
      return {
        kind: "password", chip: { label: "Needs password", tone: "danger" },
        line: "This PDF is password-protected.",
        fix: "Enter its password below and upload it again. It's still selected.",
        retry: true,
      };
    }
    if (/could not detect bank/.test(text)) {
      return {
        kind: "unsupported", chip: { label: "Not recognised", tone: "danger" },
        line: "We couldn't tell which bank this statement is from.",
        fix: "If it's password-protected, enter the password. Otherwise pick the bank below and try again. Supported: SBI, SBI Card, slice, slice card and Canara.",
        retry: true,
      };
    }
    return {
      kind: "failed", chip: { label: "Couldn't read", tone: "danger" },
      line: "Something in this PDF stopped the reader.",
      fix: "Download a fresh copy from your bank and try again. It's still selected.",
      retry: true,
    };
  }
  if (errors.length) {
    return {
      kind: "partial", chip: { label: "Some lines skipped", tone: "warning" },
      line: `${counts}. ${plural(errors.length, "line")} couldn't be read; everything else came in.`,
      retry: false,
    };
  }
  if (fresh === 0) {
    return { kind: "nothing_new", chip: { label: "Nothing new", tone: "neutral" }, line: `${counts}. Nothing was added twice.`, retry: false };
  }
  return { kind: "added", chip: { label: "Added", tone: "success" }, line: counts, retry: false };
}

const BUSY_STEPS = (count: number) => [
  `Reading ${plural(count, "statement")}…`,
  "Finding the transactions…",
  "Skipping anything already here…",
  "Matching card bills…",
  "Applying your category rules…",
];

// ---------------------------------------------------------------------------

export default function UploadPage() {
  const mode = useDataMode();
  const [files, setFiles] = useState<File[]>([]);
  const [password, setPassword] = useState("");
  const [forceBank, setForceBank] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [firstParse, setFirstParse] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSummary, setResetSummary] = useState<ResetSummary | null>(null);

  const { data: history, error: historyError, mutate: refetchHistory } = useUploadHistory();

  // Arriving from Settings → Statements: show the whole history.
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#history") setHistoryOpen(true);
  }, []);

  // Progress in words while the single upload request runs.
  useEffect(() => {
    if (!busy) return;
    setStep(0);
    const id = setInterval(() => setStep(s => Math.min(s + 1, 4)), 1800);
    return () => clearInterval(id);
  }, [busy]);

  const totals = useMemo(() => {
    if (!results) return null;
    return results.reduce(
      (acc, r) => ({ parsed: acc.parsed + (r.parsed_count || 0), fresh: acc.fresh + (r.new_count || 0), dup: acc.dup + (r.duplicate_count || 0) }),
      { parsed: 0, fresh: 0, dup: 0 },
    );
  }, [results]);

  const addFiles = useCallback((picked: FileList | File[] | null) => {
    if (!picked) return;
    const arr = Array.from(picked).filter(f => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
    setFiles(prev => {
      const seen = new Set(prev.map(f => `${f.name}|${f.size}`));
      return [...prev, ...arr.filter(f => !seen.has(`${f.name}|${f.size}`))];
    });
  }, []);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const removeFile = (i: number) => setFiles(prev => prev.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (!files.length || busy) return;
    const wasEmpty = Array.isArray(history) && history.length === 0;
    setBusy(true);
    setUploadError(null);
    setResults(null);
    setFirstParse(false);
    try {
      const resp = await uploadFiles(files, {
        password: password || undefined,
        force_bank: forceBank || undefined,
      });
      const res = resp?.results ?? [];
      setResults(res);
      // Keep files that need another go (password, unknown bank) selected.
      const retryNames = new Set(res.filter(r => outcomeOf(r).retry).map(r => r.filename));
      setFiles(prev => prev.filter(f => retryNames.has(f.name)));
      if (!retryNames.size) setPassword("");
      setFirstParse(wasEmpty && res.some(r => (r.new_count ?? 0) > 0));
      refetchHistory();
      invalidateAll();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmReset = async () => {
    setResetting(true);
    setResetError(null);
    try {
      const s = await resetSystem();
      setResetSummary(s);
      setResults(null);
      setFiles([]);
      refetchHistory();
      invalidateAll();
      setResetOpen(false);
    } catch (e) {
      setResetError(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  };

  const openPicker = () => fileInputRef.current?.click();

  return (
    <div className="mx-auto max-w-reading space-y-8 pb-16">
      <PageHeader title="Bring in statements" />

      {resetSummary && (
        <AlertBanner variant="success" onDismiss={() => setResetSummary(null)}>
          Everything was cleared: {plural(resetSummary.transactions_deleted ?? 0, "transaction")} and {plural(resetSummary.uploads_deleted ?? 0, "upload")}.
          Your {plural(resetSummary.rules_preserved ?? 0, "category rule")} were kept.
        </AlertBanner>
      )}

      {/* Dropzone (the hero) + what's selected + the one primary action */}
      <section>
        <div
          role="button"
          tabIndex={0}
          aria-label="Choose statement PDFs to upload"
          onClick={openPicker}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); } }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={clsx(
            "flex min-h-[320px] cursor-pointer flex-col items-center justify-center rounded-l border-[1.5px] bg-accent-50 px-6 py-12 text-center",
            "focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--accent-500)]",
            "transition-[transform,border-color] duration-300 ease-spring",
            dragOver ? "scale-[1.01] border-solid border-accent-500" : "border-dashed border-accent-200",
          )}
        >
          <IllustrationSlot label="stack of statements" size={128} className="mb-6 bg-card" />
          <p className="text-h3 font-black text-ink">{dragOver ? "Drop to add them" : <><span className="hidden sm:inline">Drop statements here, or choose files</span><span className="sm:hidden">Choose statements to upload</span></>}</p>
          <p className="mt-2 max-w-md text-[15px] text-muted">PDFs from SBI, SBI Card, slice, slice card and Canara.{mode === "test" ? " In test mode they go to the sample data, not yours." : ""}</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            multiple
            className="hidden"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
          />
        </div>

        {files.length > 0 && (
          <Card className="mt-4 space-y-5">
            <ul className="space-y-2">
              {files.map((f, i) => (
                <li key={`${f.name}-${f.size}`} className="flex items-center gap-3 rounded-m bg-surface py-2 pl-4 pr-2">
                  <FileText className="h-4 w-4 shrink-0 text-muted" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-ink">{f.name}</span>
                  <span className="shrink-0 text-sm tabular-nums text-muted">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                  <IconButton size="sm" aria-label={`Remove ${f.name}`} onClick={() => removeFile(i)} className="!mb-0" disabled={busy}>
                    <X className="h-4 w-4" strokeWidth={1.75} />
                  </IconButton>
                </li>
              ))}
            </ul>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="bank-pick">Which bank?</Label>
                <Select id="bank-pick" value={forceBank} onChange={(e) => setForceBank(e.target.value)} disabled={busy}>
                  {FORCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </div>
              <div>
                <Label htmlFor="pwd">PDF password, if it has one</Label>
                <Input
                  id="pwd"
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
              </div>
            </div>

            <div>
              <Button variant="primary" size="lg" onClick={submit} loading={busy} disabled={!files.length}>
                Upload {files.length > 1 ? plural(files.length, "statement") : "statement"}
              </Button>
              <p className="mt-2 text-sm text-muted">Transactions already here are never added twice.</p>
            </div>

            {busy && (
              <div className="rounded-m bg-surface px-5 py-4">
                <AiWorking>{BUSY_STEPS(files.length)[step]}</AiWorking>
              </div>
            )}
          </Card>
        )}
      </section>

      {uploadError && (
        <ErrorCard
          title="Those statements didn't upload"
          message={`The server didn't answer properly (${uploadError}). Your files are still selected. Check that the backend is running, then try again.`}
          onRetry={submit}
        />
      )}

      {/* First statement ever: a small success moment (§15) */}
      {firstParse && totals && (
        <section className="flex flex-col items-center rounded-l bg-accent-50 px-6 py-10 text-center">
          <IllustrationSlot label="coin jar with a leaf" size={120} className="mb-5 bg-card" />
          <p className="text-h3 font-black text-ink">Your first statement is in</p>
          <p className="mt-2 max-w-md text-[15px] text-ink-2">{plural(totals.fresh, "transaction")} are ready to look at.</p>
          <Link href="/" className="text-link mt-4 text-[15px]">See what you really spent →</Link>
        </section>
      )}

      {/* What came in */}
      {results && results.length > 0 && totals && (
        <Card>
          <CardTitle
            subtitle={`${plural(totals.parsed, "transaction")} read, ${n(totals.fresh)} new, ${n(totals.dup)} already here`}
            action={totals.fresh > 0 ? <Link href="/transactions" className="text-link text-sm">See transactions →</Link> : undefined}
          >
            What came in
          </CardTitle>
          <ul className="mt-4">
            {results.map((r, i) => {
              const o = outcomeOf(r);
              const extras = [
                r.cc_payments_tagged ? plural(r.cc_payments_tagged, "card bill") + " matched" : null,
                r.rules_applied ? `${n(r.rules_applied)} sorted by your rules` : null,
              ].filter(Boolean).join(" · ");
              return (
                <li key={`${r.filename}-${i}`} className="border-b border-line py-4 last:border-b-0">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-extrabold text-ink" title={r.filename}>{r.filename}</p>
                      <p className="text-sm text-muted">{r.bank ? bankName(r.bank) : "Bank not detected"}</p>
                    </div>
                    <Chip size="sm" tone={o.chip.tone}>{o.chip.label}</Chip>
                  </div>
                  <p className={clsx("mt-2 text-[15px]", o.fix ? "text-danger-text" : "text-ink-2")}>{o.line}</p>
                  {o.fix && <p className="mt-0.5 text-[15px] text-ink-2">{o.fix}</p>}
                  {extras && !o.fix && <p className="mt-0.5 text-sm text-muted">{extras}</p>}
                  {(r.errors?.length ?? 0) > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm font-semibold text-muted">Show details</summary>
                      <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto font-mono text-[12px] leading-snug text-ink-2">
                        {r.errors.map((e, j) => <li key={j}>{e}</li>)}
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* History: a quiet list */}
      <section id="history" aria-labelledby="past-uploads" className="scroll-mt-24">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="past-uploads" className="text-h3 font-black text-ink">Already in</h2>
          {history && history.length > 0 && (
            <span className="text-sm font-medium text-muted">{plural(history.length, "statement")}</span>
          )}
        </div>
        {historyError && !history ? (
          <ErrorCard className="mt-3" message="Past uploads didn't load. Check that the backend is running." onRetry={() => refetchHistory()} />
        ) : !history ? (
          <div className="mt-3 space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
        ) : history.length === 0 ? (
          <p className="mt-2 text-[15px] text-muted">Nothing yet. Statements you upload will be listed here.</p>
        ) : (
          <ul className="mt-2">
            {(historyOpen ? history : history.slice(0, 5)).map(h => (
              <li key={h.id} className="flex items-center gap-4 border-b border-line py-3 last:border-b-0" title={h.filename}>
                <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-s bg-surface text-[15px] font-black text-ink-2">
                  {bankName(h.bank).charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-ink">{bankName(h.bank)}</span>
                  <span className="block truncate text-sm text-muted">
                    {h.new_txn_count === h.txn_count
                      ? `${plural(h.txn_count, "transaction")}, all new`
                      : `${plural(h.new_txn_count, "new transaction")} of ${n(h.txn_count)}`}
                  </span>
                </span>
                <span className="shrink-0 text-sm tabular-nums text-muted">{dateLabel(h.uploaded_at)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
          {history && history.length > 5 ? (
            <button type="button" className="text-link" onClick={() => setHistoryOpen(o => !o)} aria-expanded={historyOpen}>
              {historyOpen ? "Show fewer" : `Show all ${history.length}`}
            </button>
          ) : <span />}
          <span>
            Want a clean slate?{" "}
            <button type="button" className="text-link" onClick={() => { setResetError(null); setResetOpen(true); }}>
              Clear all transactions…
            </button>
          </span>
        </div>
      </section>

      {/* By hand: what never reaches a statement. ManualEntry carries its own title. */}
      <section aria-label="Add by hand" className="space-y-2 pt-4">
        <ManualEntry />
        <p className="px-1 text-sm text-muted">
          Change or remove these later on <Link href="/wealth" className="text-link">Wealth</Link>.
        </p>
      </section>

      <Modal
        open={resetOpen}
        onClose={() => { if (!resetting) setResetOpen(false); }}
        title="Clear all transactions?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetOpen(false)} disabled={resetting}>Cancel</Button>
            <Button variant="danger" onClick={confirmReset} loading={resetting}>Clear everything</Button>
          </>
        }
      >
        <div className="space-y-3 text-[15px] text-ink-2">
          <p>This deletes every transaction, account, EMI plan and upload record{mode === "test" ? " in the sample data" : ""}. It can&apos;t be undone.</p>
          <p>Your category rules stay, and apply again as soon as you upload statements.</p>
          {resetError && (
            <p className="rounded-m bg-danger-tint px-4 py-3 text-danger-text">
              That didn&apos;t finish ({resetError}). Try again in a moment.
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
