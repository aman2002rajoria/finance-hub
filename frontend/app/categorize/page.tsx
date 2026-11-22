"use client";

// Categorise: check what's uncategorised and fix it.
// Title → one status sentence → the queue (list left, selected right).
// Bulk Excel and maintenance tools sit behind "More ways to tag".

import { ArrowRight, Download, RefreshCw, Sparkles, Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { BulkTagView } from "@/components/categorize/BulkTagView";
import { errorText, plural } from "@/components/ledger/format";
import { ConfirmDialog } from "@/components/ledger/primitives";
import {
  AiWorking, AlertBanner, Button, Card, CardTitle, PageHeader, PageSection, ProgressBar,
} from "@/components/ui";
import {
  downloadUncategorizedExcel, importCategorizationSheet, invalidateAll,
  reapplyRules, recanonicalizeMerchants, useProgress,
} from "@/lib/api";
import type { CategorizationProgress } from "@/lib/types";

/**
 * The progress this visit: "6 of 23 tagged" with a bar that fills as you go.
 * The baseline is what was untagged when the page opened, so every tag moves it.
 */
function TagProgress({ p }: { p: CategorizationProgress | undefined }) {
  const [start, setStart] = useState<number | null>(null);
  useEffect(() => {
    if (!p) return;
    setStart(s => (s == null || p.uncategorized_transactions > s ? p.uncategorized_transactions : s));
  }, [p]);

  if (!p || start == null) return <div className="skeleton h-10 w-full max-w-[420px]" />;
  const left = p.uncategorized_transactions;
  if (start === 0) {
    return <p className="text-[15px] font-medium text-ink-2">Nothing to tag. New statements are tagged by your rules as they arrive.</p>;
  }
  const done = Math.max(0, start - left);
  return (
    <div className="w-full max-w-[420px]">
      <p className="text-[15px] text-ink-2">
        <span className="font-extrabold tabular-nums text-ink">{done} of {start}</span> tagged
        {left === 0
          ? <span className="text-success-text">. All done, and your rules will tag new ones.</span>
          : <span className="text-muted"> · {plural(p.uncategorized_counterparties, "counterparty", "counterparties")} to go</span>}
      </p>
      <ProgressBar className="mt-2" value={done} max={start} showValue={false} label={undefined} />
    </div>
  );
}

export default function CategorizePage() {
  const { data: progress } = useProgress();

  const [toolsOpen, setToolsOpen] = useState(false);
  const [busy, setBusy] = useState<null | "rules" | "canon" | "export" | "import">(null);
  const [canonConfirm, setCanonConfirm] = useState(false);
  const [toolResult, setToolResult] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function runTool(which: "rules" | "canon" | "export", fn: () => Promise<string | void>) {
    setBusy(which);
    setToolResult(null);
    try {
      const msg = await fn();
      if (msg) setToolResult({ tone: "success", text: msg });
      invalidateAll();
    } catch (e) {
      setToolResult({ tone: "danger", text: `That didn't work: ${errorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy("import");
    setToolResult(null);
    try {
      const r = await importCategorizationSheet(file);
      invalidateAll();
      setToolResult({
        tone: "success",
        text: `Read your sheet: ${plural(r.transactions_updated, "transaction")} tagged and ${plural(r.rules_created, "rule")} saved.`,
      });
    } catch (err) {
      setToolResult({ tone: "danger", text: `That sheet didn't import: ${errorText(err)}. Check it's the downloaded file, then try again.` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageSection className="space-y-6">
      <PageHeader
        title="Check what's untagged and fix it"
        description="Tag a counterparty once and every charge from it follows."
        meta={<TagProgress p={progress} />}
      />

      <BulkTagView />

      {/* Occasional tools, folded away. */}
      <Card>
        <CardTitle
          subtitle={<>Fill in a spreadsheet, re-run your rules, or <Link href="/rules" className="text-link">see every rule <ArrowRight className="inline h-3.5 w-3.5" strokeWidth={1.75} /></Link></>}
          action={
            <Button variant="ghost" size="sm" aria-expanded={toolsOpen} onClick={() => setToolsOpen(o => !o)}>
              {toolsOpen ? "Hide" : "Show"}
            </Button>
          }
        >
          More ways to tag
        </CardTitle>
        {toolsOpen && (
          <div className="rise-in mt-5 space-y-5">
            {toolResult && <AlertBanner variant={toolResult.tone}>{toolResult.text}</AlertBanner>}
            {busy === "import" && <AiWorking>Reading your sheet and tagging what it lists…</AiWorking>}
            {busy === "rules" && <AiWorking>Running your saved rules over every transaction…</AiWorking>}
            {busy === "canon" && <AiWorking>Re-reading merchant names from each description…</AiWorking>}

            <div className="rounded-m bg-surface p-5">
              <p className="font-extrabold text-ink">Tag in a spreadsheet</p>
              <p className="mt-1 text-sm text-muted">
                Download the untagged groups, fill in a category for each row, then upload the same file.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" loading={busy === "export"} onClick={() => runTool("export", async () => { await downloadUncategorizedExcel(); })}>
                  <Download className="h-4 w-4" strokeWidth={1.75} /> Download untagged (.xlsx)
                </Button>
                <Button variant="ghost" size="sm" disabled={busy === "import"} onClick={() => fileRef.current?.click()}>
                  <Upload className="h-4 w-4" strokeWidth={1.75} /> Upload filled sheet
                </Button>
                <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFilePick} />
              </div>
            </div>

            <div className="rounded-m bg-surface p-5">
              <p className="font-extrabold text-ink">Tidy up</p>
              <p className="mt-1 text-sm text-muted">Useful after you change parsers or import old statements.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!busy}
                  onClick={() => runTool("rules", async () => {
                    const r = await reapplyRules();
                    return `Re-ran your saved rules: ${plural(r.rows_updated, "transaction")} updated.`;
                  })}
                >
                  <RefreshCw className="h-4 w-4" strokeWidth={1.75} /> Re-run saved rules
                </Button>
                <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setCanonConfirm(true)}>
                  <Sparkles className="h-4 w-4" strokeWidth={1.75} /> Re-read merchant names
                </Button>
              </div>
            </div>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={canonConfirm}
        title="Re-read every merchant name?"
        confirmLabel="Re-read merchant names"
        onClose={() => setCanonConfirm(false)}
        onConfirm={() => {
          setCanonConfirm(false);
          void runTool("canon", async () => {
            const r = await recanonicalizeMerchants();
            return `Re-read ${plural(r.transactions_scanned, "transaction")}: ${plural(r.merchant_changed, "merchant name")} changed.`;
          });
        }}
        note="Categories don't change, only the counterparty names."
      >
        <p>Each transaction&apos;s counterparty is worked out again from its description. Groups on this page may merge or split.</p>
      </ConfirmDialog>

    </PageSection>
  );
}
