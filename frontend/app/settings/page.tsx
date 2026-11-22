"use client";

/*
 * Settings: short cards in a 720px reading column (design.md §5.2).
 * 1. You: age, income and cover, used by the wealth and goals maths.
 * 2. Appearance: light, dark or follow the system.
 * 3. Data: own data or test data (§16).
 * 4. Statements and tagging rules: link rows to /upload and /rules.
 */

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type React from "react";
import { useEffect, useState } from "react";

import { fullDate } from "@/components/ledger/format";
import {
  AlertBanner, Button, Card, CardTitle, Input, Label,
  PageHeader, Segmented, Skeleton,
} from "@/components/ui";
import { useRules, useUploadHistory } from "@/lib/api";
import { effectiveMode, setDataMode, TEST_ONLY, useDataMode, type DataMode } from "@/lib/dataMode";
import { setTheme, useTheme, type ThemeChoice } from "@/lib/theme";
import { lakhWords } from "@/components/analytics/fmt";
import { inr } from "@/lib/format";
import { useWealth, wealth, type Profile } from "@/lib/wealth";

// ---------------------------------------------------------------------------
// You: the profile behind the wealth and goals numbers
// ---------------------------------------------------------------------------

type ProfileForm = Record<
  "age" | "retireAge" | "monthlyIncome" | "sipStepUpPct" | "emergencyMonthsTarget" | "termCover" | "healthCover" | "targetEquityPct",
  string
>;

const toForm = (p: Profile): ProfileForm => ({
  age: String(p.age),
  retireAge: String(p.retireAge),
  monthlyIncome: p.monthlyIncome != null ? String(p.monthlyIncome) : "",
  sipStepUpPct: String(p.sipStepUpPct),
  emergencyMonthsTarget: String(p.emergencyMonthsTarget),
  termCover: p.termCover != null ? String(p.termCover) : "",
  healthCover: p.healthCover != null ? String(p.healthCover) : "",
  targetEquityPct: p.targetEquityPct != null ? String(p.targetEquityPct) : "",
});

function NumField({
  id, label, value, onChange, unit, placeholder, prefix, min, max, step, className,
}: {
  className?: string;
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit?: string;
  prefix?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className={`min-w-0 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        {prefix && (
          <span aria-hidden className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-base text-muted">{prefix}</span>
        )}
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step ?? "any"}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={`tabular-nums ${prefix ? "pl-9" : ""} ${unit ? "pr-[84px]" : ""}`}
        />
        {unit && (
          <span aria-hidden className="pointer-events-none absolute right-5 top-1/2 -translate-y-1/2 text-sm font-medium text-muted">{unit}</span>
        )}
      </div>
    </div>
  );
}

function ProfileCard() {
  const w = useWealth();
  const profile = w.state.profile;
  const [form, setForm] = useState<ProfileForm>(() => toForm(profile));
  const [msg, setMsg] = useState<{ variant: "success" | "danger"; text: string } | null>(null);

  // Pick up the stored profile once it loads, and after a data-mode switch.
  useEffect(() => { setForm(toForm(profile)); }, [profile]);

  const set = (k: keyof ProfileForm) => (v: string) => { setForm((f) => ({ ...f, [k]: v })); setMsg(null); };
  const ageNow = Number(form.age) || profile.age;
  const ageRule = Math.min(80, Math.max(40, 100 - ageNow));
  const statementIncome = profile.monthlyIncome == null ? w.income : 0;

  const save = () => {
    const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
    const age = num(form.age), retireAge = num(form.retireAge);
    const step = num(form.sipStepUpPct), months = num(form.emergencyMonthsTarget);
    const eq = num(form.targetEquityPct);
    if (age == null || age < 16 || age > 90) return setMsg({ variant: "danger", text: "Age should be between 16 and 90." });
    if (retireAge == null || retireAge <= age || retireAge > 90) {
      return setMsg({ variant: "danger", text: "Retirement age should be after your age, and 90 at most." });
    }
    if (step == null || step < 0 || step > 50) return setMsg({ variant: "danger", text: "SIP step-up should be between 0% and 50% a year." });
    if (months == null || months < 0 || months > 36) return setMsg({ variant: "danger", text: "Emergency fund target should be between 0 and 36 months." });
    if (eq != null && (eq < 0 || eq > 100)) return setMsg({ variant: "danger", text: "Equity share should be between 0% and 100%." });
    const money = [num(form.monthlyIncome), num(form.termCover), num(form.healthCover)];
    if (money.some((m) => m != null && m < 0)) return setMsg({ variant: "danger", text: "Amounts can't be negative." });

    wealth.setProfile({
      age, retireAge, sipStepUpPct: step, emergencyMonthsTarget: months,
      monthlyIncome: money[0], termCover: money[1], healthCover: money[2], targetEquityPct: eq,
    });
    setMsg({ variant: "success", text: "Saved. Your wealth and goals now use these numbers." });
  };

  return (
    <Card>
      <CardTitle>You</CardTitle>
      <p className="mt-2 text-[15px] text-ink-2">
        Your wealth and goals use these for projections, the emergency fund and how much equity suits you.
        {w.mode === "test" ? " In test data, they belong to the sample person." : ""}
      </p>

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5">
        <NumField id="pf-age" label="Age" value={form.age} onChange={set("age")} unit="years" min={16} max={90} step={1} />
        <NumField id="pf-retire" label="Retirement age" value={form.retireAge} onChange={set("retireAge")} unit="years" min={17} max={90} step={1} />
        <NumField id="pf-step" label="SIP step-up a year" value={form.sipStepUpPct} onChange={set("sipStepUpPct")} unit="%" min={0} max={50} />
        <NumField id="pf-em" label="Emergency fund" value={form.emergencyMonthsTarget} onChange={set("emergencyMonthsTarget")} unit="months" min={0} max={36} step={1} />
        <NumField
          className="col-span-2 sm:col-span-1"
          id="pf-income"
          label="Monthly income (optional)"
          value={form.monthlyIncome}
          onChange={set("monthlyIncome")}
          prefix="₹"
          placeholder={statementIncome > 0 ? `${inr(Math.round(statementIncome)).replace("₹", "")} from statements` : "From your statements"}
          min={0}
          unit={Number(form.monthlyIncome) >= 1000 ? lakhWords(Number(form.monthlyIncome)).replace("₹", "") : undefined}
        />
        <NumField
          className="col-span-2 sm:col-span-1"
          id="pf-eq"
          label="Equity share (optional)"
          value={form.targetEquityPct}
          onChange={set("targetEquityPct")}
          unit="%"
          placeholder={`Age rule: ${ageRule}`}
          min={0}
          max={100}
        />
        <NumField
          className="col-span-2 sm:col-span-1"
          id="pf-life" label="Life cover" value={form.termCover} onChange={set("termCover")} prefix="₹" placeholder="None" min={0}
          unit={Number(form.termCover) >= 1000 ? lakhWords(Number(form.termCover)).replace("₹", "") : undefined}
        />
        <NumField
          className="col-span-2 sm:col-span-1"
          id="pf-health" label="Health cover" value={form.healthCover} onChange={set("healthCover")} prefix="₹" placeholder="None" min={0}
          unit={Number(form.healthCover) >= 1000 ? lakhWords(Number(form.healthCover)).replace("₹", "") : undefined}
        />
      </div>
      <p className="mt-3 text-sm text-muted">
        Leave income empty to use your statement average. The age rule is 100 minus your age, kept between 40% and 80%.
      </p>

      {msg && (
        <div className="mt-5">
          <AlertBanner variant={msg.variant} onDismiss={() => setMsg(null)}>{msg.text}</AlertBanner>
        </div>
      )}

      <div className="mt-5">
        <Button variant="primary" onClick={save}>Save profile</Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Appearance card
// ---------------------------------------------------------------------------

function AppearanceCard() {
  const choice = useTheme();
  return (
    <Card>
      <CardTitle>Appearance</CardTitle>
      <p className="mt-2 text-[15px] text-ink-2">System follows your device, so the app goes dark when your computer does.</p>
      <Segmented<ThemeChoice>
        className="mt-5"
        ariaLabel="Theme"
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
          { value: "system", label: "System" },
        ]}
        value={choice}
        onChange={setTheme}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Data card
// ---------------------------------------------------------------------------

function DataCard() {
  const raw = useDataMode();
  const pending = raw === "pending";
  const current: DataMode = TEST_ONLY ? "test" : raw === "test" || raw === "own" ? raw : pending ? "own" : effectiveMode();

  return (
    <Card>
      <CardTitle>Data</CardTitle>
      <p className="mt-2 text-[15px] text-ink-2">
        Test data is a made-up set of statements, so you can try every screen without uploading anything of yours.
      </p>
      <div className="mt-5">
        {pending ? (
          <Skeleton className="h-11 w-64 rounded-pill" />
        ) : TEST_ONLY ? (
          <p className="text-sm text-muted">This public version only has test data, so your own statements can never be shown here.</p>
        ) : (
          <>
            <Segmented<DataMode>
              ariaLabel="Which data to use"
              options={[
                { value: "own", label: "My own data" },
                { value: "test", label: "Test data" },
              ]}
              value={current}
              onChange={(m) => { if (m !== current) setDataMode(m); }}
            />
            <p className="mt-3 text-sm text-muted">
              {current === "test"
                ? "Anything you upload or change here goes to the sample, never your own data. "
                : ""}
              Switching reloads the app.
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Statements and tagging rules: short link rows to where they live
// ---------------------------------------------------------------------------

function LinkRow({ href, emoji, title, sub }: { href: string; emoji: string; title: string; sub: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-4 rounded-l bg-card p-5 shadow-flat transition-colors hover:bg-surface md:p-6"
    >
      <span aria-hidden className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-surface text-[20px] group-hover:bg-card">{emoji}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-h3 font-black text-ink">{title}</span>
        <span className="mt-0.5 block truncate text-sm font-medium text-muted">{sub}</span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" strokeWidth={1.75} aria-hidden />
    </Link>
  );
}

function StatementsRow() {
  const { data, error } = useUploadHistory();
  const last = data?.reduce<string | null>((m, h) => (!m || (h.uploaded_at ?? "") > m ? h.uploaded_at ?? m : m), null);
  const sub = error && !data
    ? "Upload history didn't load"
    : !data
      ? "Loading…"
      : data.length === 0
        ? "Nothing uploaded yet"
        : `${data.length} uploaded${last ? `, last on ${fullDate(last)}` : ""}`;
  return <LinkRow href="/upload#history" emoji="📄" title="Statements" sub={sub} />;
}

function RulesRow() {
  const { data, error } = useRules();
  const on = data?.filter(r => r.enabled !== false).length ?? 0;
  const sub = error && !data
    ? "Rules didn't load"
    : !data
      ? "Loading…"
      : data.length === 0
        ? "No rules yet"
        : `${data.length} ${data.length === 1 ? "rule" : "rules"}${on < data.length ? `, ${on} on` : ""}`;
  return <LinkRow href="/rules" emoji="🏷️" title="Tagging rules" sub={sub} />;
}

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-reading space-y-6 pb-16">
      <PageHeader title="Settings" />
      <ProfileCard />
      <AppearanceCard />
      <DataCard />
      <StatementsRow />
      <RulesRow />
    </div>
  );
}
