"use client";

import { ArrowUpRight, Lock, Pencil, Plus, SlidersHorizontal, X } from "lucide-react";

import { NetWorthChart } from "../charts";
import { dayMonth, rupees, short, type IosData } from "../data";
import { Card, Chip, EmojiTile, Group, InlineNav, LargeTitle, M, NavCircle, Row, Screen, SectionHeader, Segmented, STATUS_H, type Theme } from "../kit";

const CLASS_COLOR = { equity: "#00B86B", debt: "#00A3BF", gold: "#FFB020", cash: "#7C5CFF", other: "#A1A1A8" } as const;

/* ------------------------------------------------------------ Wealth */

function WealthBody({ d, active }: { d: IosData; active?: string }) {
  const t = d.w.totals;
  const d0 = d.w.daily[0];
  const first = d0?.netWorth ?? t.netWorth;
  // Same split as the web Wealth chart: money you added vs what markets did.
  const putIn = t.invested - (d0?.invested ?? t.invested);
  const saved = t.cash - (d0?.cash ?? t.cash) + putIn;
  const markets = t.investments - (d0?.investments ?? t.investments) - putIn;
  return (
    <>
      <LargeTitle title="Wealth" trailing={<NavCircle label="Add investment"><Plus size={19} strokeWidth={2.4} /></NavCircle>} />
      <div style={{ padding: `0 ${M + 4}px` }}>
        <div className="subhead l2">Net worth</div>
        <div className="brand" style={{ fontSize: 40, lineHeight: "46px", marginTop: 2 }}>{rupees(t.netWorth)}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <Chip tone="pos"><ArrowUpRight size={14} strokeWidth={2.6} />{short(t.netWorth - first)} since 1 Jun</Chip>
          <span className="footnote l2">{short(saved)} saved · {short(markets, 0)} from markets</span>
        </div>
      </div>
      <Card pad={0} style={{ marginTop: 18, paddingTop: 10 }}>
        <div style={{ padding: "4px 14px 0" }}>
          <NetWorthChart daily={d.w.daily} markers={d.w.markers} w={342} h={214} top={36} active={active} yTicks />
        </div>
        <div style={{ padding: "10px 16px 14px" }}>
          <Segmented items={["1M", "3M", "6M"]} active={2} />
        </div>
      </Card>
      <div style={{ height: 22 }} />
      <Group>
        <Row icon={<EmojiTile emoji="📈" bg="var(--tint-soft)" />} title="Investments" value={short(t.investments)} valueSub={<span style={{ color: "var(--pos)" }}>+{t.gainPct.toFixed(1)}%</span>} chevron inset={60} />
        <Row icon={<EmojiTile emoji="🏦" />} title="Bank cash" value={short(t.cash)} valueSub={<span className="l2">3 accounts</span>} chevron />
        <Row icon={<EmojiTile emoji="💳" />} title="Card bills due" value={`−${rupees(t.liabilities)}`} valueSub={<span className="l2">2 cards</span>} chevron last />
      </Group>
    </>
  );
}

export function WealthScreen({ d, theme }: { d: IosData; theme: Theme }) {
  return <Screen theme={theme} tab="wealth"><WealthBody d={d} /></Screen>;
}

/* ------------------------------------------------------- Investments */

const GROUPS: { key: string; label: string; kinds: string[] }[] = [
  { key: "mf", label: "Mutual funds", kinds: ["equity_mf", "elss", "debt_mf", "liquid_mf"] },
  { key: "fi", label: "Bonds and deposits", kinds: ["fd", "bonds"] },
  { key: "rt", label: "Retirement", kinds: ["epf", "ppf", "nps"] },
  { key: "mk", label: "Stocks and gold", kinds: ["stocks", "gold"] },
];

const SHORT_NAME: Record<string, string> = {
  "Parag Parikh Flexi Cap Fund": "Parag Parikh Flexi Cap",
  "Mirae Asset ELSS Tax Saver": "Mirae ELSS Tax Saver",
  "UTI Nifty 50 Index Fund": "UTI Nifty 50 Index",
  "RBI Floating Rate Savings Bond": "RBI Floating Rate Bond",
  "Sovereign Gold Bond 2024 Series I": "Sovereign Gold Bond",
  "Direct stocks (4 companies)": "Stocks · 4 companies",
};

export function InvestmentsScreen({ d, theme }: { d: IosData; theme: Theme }) {
  const t = d.w.totals;
  const byClass = new Map<string, number>();
  for (const h of d.holdings) byClass.set(h.cls, (byClass.get(h.cls) ?? 0) + h.h.current);
  const classes = Array.from(byClass.entries()).sort((a, b) => b[1] - a[1]);
  return (
    <Screen theme={theme} tab="wealth">
      <InlineNav back="Wealth" title="Investments" trailing={<SlidersHorizontal size={20} strokeWidth={2.1} className="tint" />} />
      <div style={{ paddingTop: STATUS_H + 44 + 14 }}>
        <Card>
          <div style={{ display: "grid", gridTemplateColumns: "1.15fr 1fr 0.9fr", gap: 8 }}>
            {[
              ["Worth", short(t.investments), undefined],
              ["Put in", short(t.invested), undefined],
              ["Gain", `+${t.gainPct.toFixed(1)}%`, "var(--pos)"],
            ].map(([k, v, c]) => (
              <div key={k}>
                <div className="footnote l2">{k}</div>
                <div className="brand" style={{ fontSize: 24, lineHeight: "30px", color: c }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", gap: 2, marginTop: 14 }}>
            {classes.map(([k, v]) => <span key={k} style={{ flex: v, background: CLASS_COLOR[k as keyof typeof CLASS_COLOR] }} />)}
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 9 }} className="footnote">
            {classes.map(([k, v]) => (
              <span key={k} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: CLASS_COLOR[k as keyof typeof CLASS_COLOR] }} />
                <span style={{ textTransform: "capitalize" }}>{k}</span>
                <span className="l2">{Math.round((v / t.investments) * 100)}%</span>
              </span>
            ))}
            <span className="l2" style={{ marginLeft: "auto" }}>{d.w.xirrPct?.toFixed(1)}%/yr</span>
          </div>
        </Card>
        <Segmented items={["All", "Can withdraw", "Locked"]} active={0} style={{ margin: `16px ${M}px 0` }} />
        {GROUPS.map((g) => {
          const hs = d.holdings.filter((h) => g.kinds.includes(h.h.kind));
          if (!hs.length) return null;
          const total = hs.reduce((s, h) => s + h.h.current, 0);
          return (
            <div key={g.key} style={{ marginTop: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: `0 ${M + 4}px 6px` }}>
                <span className="section-h">{g.label}</span>
                <span className="section-h" style={{ textTransform: "none" }}>{rupees(total)}</span>
              </div>
              <Group>
                {hs.map((h, i) => (
                  <Row
                    key={h.h.id}
                    icon={<EmojiTile emoji={h.emoji} size={34} />}
                    title={SHORT_NAME[h.h.name] ?? h.h.name}
                    sub={<>{h.xirr != null ? `${h.xirr.toFixed(1)}% a year` : ""}{h.lockText && <span style={{ display: "inline-flex", alignItems: "center", gap: 3, marginLeft: 6, padding: "0 6px", height: 20, borderRadius: 6, background: "var(--fill)", fontSize: 13 }}><Lock size={11} strokeWidth={2.6} style={{ display: "inline" }} />{h.lockText}</span>}</>}
                    value={rupees(h.h.current)}
                    valueSub={<span style={{ color: h.gain >= 0.5 ? "var(--pos)" : "var(--l2)" }}>{h.gain >= 0.5 ? "+" : ""}{h.gainPct.toFixed(1)}%</span>}
                    inset={62}
                    last={i === hs.length - 1}
                  />
                ))}
              </Group>
            </div>
          );
        })}
      </div>
    </Screen>
  );
}

/* ------------------------------------------------------ Moment sheet */

export function MomentSheetScreen({ d, theme }: { d: IosData; theme: Theme }) {
  const m = d.w.markers.find((k) => k.kind === "income") ?? d.w.markers[0];
  const at = (iso: string) => d.w.daily.find((p) => p.date >= iso)?.netWorth ?? 0;
  const before = at(addDays(m.date, -1));
  const after = at(addDays(m.date, 6));
  const SHEET_TOP = 468;
  return (
    <Screen theme={theme} tab="wealth">
      <WealthBody d={d} active={m.date} />
      {/* dimming */}
      <div style={{ position: "absolute", inset: 0, background: "var(--scrim)", zIndex: 35 }} />
      <div style={{
        position: "absolute", left: 0, right: 0, top: SHEET_TOP, bottom: 0, zIndex: 45,
        background: theme === "dark" ? "#1C1C1E" : "#F2F2F7", borderRadius: "38px 38px 0 0",
        boxShadow: "0 -10px 40px rgba(0,0,0,.18)",
      }}>
        <span aria-hidden style={{ position: "absolute", top: 5, left: "50%", marginLeft: -18, width: 36, height: 5, borderRadius: 3, background: "var(--l3)" }} />
        <span aria-label="Close" style={{ position: "absolute", top: 16, right: 16, width: 30, height: 30, borderRadius: 15, background: "var(--fill)", display: "grid", placeItems: "center", color: "var(--l2)" }}>
          <X size={16} strokeWidth={2.8} />
        </span>
        <div style={{ padding: `22px ${M + 4}px 0`, display: "flex", gap: 14, alignItems: "center" }}>
          <EmojiTile emoji={m.emoji} size={56} bg="var(--tint-soft)" />
          <div>
            <div className="brand" style={{ fontSize: 24, lineHeight: "29px" }}>{m.label}</div>
            <div className="subhead l2" style={{ marginTop: 2 }}>{dayMonth(m.date)} · Kestrel Analytics</div>
          </div>
        </div>
        <div style={{ padding: `18px ${M + 4}px 0`, display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <span className="brand" style={{ fontSize: 34, lineHeight: "40px", color: "var(--pos)" }}>+{rupees(m.amount)}</span>
          <span className="footnote l2">into SBI savings</span>
        </div>
        <div style={{ height: 16 }} />
        <div style={{ margin: `0 ${M}px`, borderRadius: 14, background: "var(--cell)", overflow: "hidden" }} className="sheet-group">
          <Row title="Net worth that week" value={<span>{short(before)} <span className="l3">→</span> {short(after)}</span>} />
          <Row title="Counted in" value={<span className="l2">October income</span>} />
          <Row title="One-off" value={<span className="l2">Left out of a usual month</span>} last />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.25fr", gap: 10, padding: `20px ${M}px 0` }}>
          <span className="ios-btn ghost">Hide</span>
          <span className="ios-btn"><Pencil size={17} strokeWidth={2.3} />Rename</span>
        </div>
      </div>
    </Screen>
  );
}

function addDays(iso: string, n: number) {
  const t = new Date(iso + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
