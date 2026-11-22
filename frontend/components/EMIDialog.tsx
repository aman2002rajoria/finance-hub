"use client";

import { useEffect, useState } from "react";

import { errorText, fullDate } from "@/components/ledger/format";
import { createEMI, deleteEMI, invalidateAll } from "@/lib/api";
import { inr, monthLabel } from "@/lib/format";
import type { EMIInstalment, Transaction } from "@/lib/types";

import { AlertBanner, Button, Input, Label, Modal, Select } from "./ui";

const TENURE_OPTIONS = [3, 6, 9, 12, 18, 24, 36, 48];

/**
 * Spread one card charge over N months so monthly spend reflects what you
 * actually pay. Removing a plan asks first, inside the same dialog.
 */
export default function EMIDialog({
  txn, open, onClose,
}: {
  txn: Transaction | null;
  open: boolean;
  onClose: () => void;
}) {
  const [tenure, setTenure] = useState(3);
  const [startDate, setStartDate] = useState<string>("");
  const [note, setNote] = useState("");
  const [schedule, setSchedule] = useState<EMIInstalment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Fresh form for every transaction.
  useEffect(() => {
    setTenure(3);
    setStartDate("");
    setNote("");
    setSchedule(null);
    setError(null);
    setConfirmRemove(false);
  }, [txn?.id]);

  if (!open || !txn) return null;

  const isAlreadyEMI = txn.is_emi;
  const monthly = txn.amount / tenure;

  async function submit() {
    if (!txn) return;
    setBusy(true);
    setError(null);
    try {
      const resp = await createEMI({
        txn_id: txn.id,
        tenure_months: tenure,
        start_date: startDate || undefined,
        note: note || undefined,
      });
      setSchedule(resp.schedule);
      invalidateAll();
    } catch (e: unknown) {
      setError(`That plan didn't save: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!txn) return;
    setBusy(true);
    setError(null);
    try {
      await deleteEMI(txn.id);
      invalidateAll();
      onClose();
    } catch (e: unknown) {
      setError(`The plan is still there: ${errorText(e)}`);
      setConfirmRemove(false);
    } finally {
      setBusy(false);
    }
  }

  if (confirmRemove) {
    return (
      <Modal
        open={open}
        onClose={() => setConfirmRemove(false)}
        title="Remove this EMI plan?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)} disabled={busy}>Keep plan</Button>
            <Button variant="danger" onClick={remove} loading={busy}>Remove plan</Button>
          </>
        }
      >
        <p className="text-[15px] leading-relaxed text-ink-2">
          The full {inr(txn.amount)} counts again in {fullDate(txn.date)}&apos;s month instead of being spread
          out. You can set up a new plan any time.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isAlreadyEMI ? "Change this EMI plan" : "Spread this charge as an EMI"}
      width="max-w-[560px]"
      footer={
        <>
          {isAlreadyEMI && (
            <Button variant="ghost" onClick={() => setConfirmRemove(true)} disabled={busy} className="mr-auto">
              Remove plan
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>{schedule ? "Done" : "Cancel"}</Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            {isAlreadyEMI ? "Save plan" : `Spread over ${tenure} months`}
          </Button>
          <p className="w-full text-right text-sm font-medium text-muted">
            Monthly spend shows the instalment instead of the full charge.
          </p>
        </>
      }
    >
      <div className="space-y-5">
        <div className="rounded-m bg-surface p-4">
          <p className="text-[13px] font-semibold text-muted">
            {fullDate(txn.date)} · {txn.account_name}
          </p>
          <p className="mt-1 line-clamp-2 break-words font-semibold text-ink">{txn.merchant_name || txn.description}</p>
          <p className="mt-1 text-h3 font-black tabular-nums text-ink">{inr(txn.amount)}</p>
        </div>

        {error && <AlertBanner variant="danger">{error}</AlertBanner>}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="emi-tenure">Months</Label>
            <Select id="emi-tenure" value={tenure} onChange={e => setTenure(Number(e.target.value))}>
              {TENURE_OPTIONS.map(t => (
                <option key={t} value={t}>{t} months</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="emi-start">First instalment (optional)</Label>
            <Input id="emi-start" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
          </div>
        </div>
        <div>
          <Label htmlFor="emi-note">Note (optional)</Label>
          <Input
            id="emi-note"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Converted in the card app at 12% a year"
          />
        </div>

        <p className="text-[15px] text-ink-2">
          About <span className="font-black tabular-nums text-ink">{inr(monthly)}</span> a month.
          <span className="text-muted"> The last instalment absorbs any rounding.</span>
        </p>

        {schedule && (
          <div className="rise-in">
            <p className="mb-2 text-[13px] font-semibold text-muted">Schedule</p>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {schedule.map((ins, i) => (
                <li key={i} className="flex items-center justify-between gap-2 rounded-s bg-surface px-3 py-2 text-sm">
                  <span className="font-semibold text-ink-2">{monthLabel(ins.period)}</span>
                  <span className="tabular-nums text-ink">{inr(ins.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
