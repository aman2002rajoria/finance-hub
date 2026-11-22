"use client";

import { Search } from "lucide-react";

import { SHOW_MONTH, dayMonth, monthName, rupees, short, type IosData } from "../data";
import { Chip, EmojiTile, Group, LargeTitle, M, NavCircle, Screen, SectionHeader, Segmented, type Theme } from "../kit";

const HATCH = "repeating-linear-gradient(-45deg, var(--tint-fill) 0 3px, transparent 3px 6px)";

export function SpendingScreen({ d, theme }: { d: IosData; theme: Theme }) {
  const cur = d.cur!;
  const big = d.oneOffs.find((o) => o.kind === "spend");
  const oneOff = big ? Math.abs(big.amount) : 0;
  const rows = d.where.slice(0, 6);
  // Scale bars to the biggest regular amount, so the one-off doesn't flatten the rest.
  const regular = (r: (typeof rows)[number]) => (r.category === "Electronics" ? r.amount - oneOff : r.amount);
  const max = Math.max(...rows.map((r) => Math.max(regular(r), r.usual)));
  const months = d.monthly.map((m) => m.period).slice(1);
  const repeats = d.recurring.slice(0, 5);
  const repeatTotal = d.recurring.reduce((s, r) => s + r.typical_amount, 0);
  return (
    <Screen theme={theme} tab="spending">
      <LargeTitle title="Spending" trailing={<NavCircle label="Search"><Search size={17} strokeWidth={2.3} /></NavCircle>} />
      <Segmented items={months.map((p) => (p === "2026-11" ? "Nov" : monthName(p)))} active={months.indexOf(SHOW_MONTH)} style={{ margin: `4px ${M}px 0` }} />

      <div style={{ padding: `20px ${M + 4}px 0` }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span className="brand" style={{ fontSize: 34, lineHeight: "40px" }}>{rupees(cur.living)}</span>
          <span className="subhead l2">spent</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          {big && <Chip tone="warn">{big.emoji} {short(oneOff)} iPad, one-off</Chip>}
          <span className="footnote l2">Usual month {short(d.w.usual.spend, 0)}</span>
        </div>
      </div>

      <div style={{ height: 24 }} />
      <SectionHeader>Where it went</SectionHeader>
      <Group>
        {rows.map((r, i) => {
          const reg = regular(r);
          const isBig = r.category === "Electronics" && oneOff > 0;
          const over = r.amount > r.usual * 1.15 && !isBig && r.category !== "Untagged";
          return (
            <div key={r.category} style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, padding: `10px ${M}px 10px` }}>
              <EmojiTile emoji={r.emoji} size={34} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontSize: 17 }}>{r.category}</span>
                  <span style={{ fontSize: 17, fontWeight: 600 }}>{rupees(r.amount)}</span>
                </div>
                <div style={{ position: "relative", height: 6, marginTop: 7, borderRadius: 3, background: "var(--fill)" }}>
                  <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 3, width: `${(Math.min(reg, max) / max) * 100}%`, background: over ? "#FFB020" : "var(--tint-fill)" }} />
                  {isBig && <span style={{ position: "absolute", top: 0, bottom: 0, left: `${(reg / max) * 100}%`, right: 0, borderRadius: "0 3px 3px 0", background: HATCH, opacity: 0.55 }} />}
                  <span aria-hidden style={{ position: "absolute", top: -3, bottom: -3, width: 2, borderRadius: 1, left: `calc(${(Math.min(r.usual, max) / max) * 100}% - 1px)`, background: "var(--l1)", opacity: 0.55 }} />
                </div>
                <div className="caption l2" style={{ marginTop: 4 }}>
                  {isBig ? <>Usual {short(r.usual)} · {big!.emoji} {short(oneOff)} one-off</> : over ? <>Usual {short(r.usual)} · <span style={{ color: "var(--warn)", fontWeight: 600 }}>+{short(r.amount - r.usual)}</span></> : <>Usual {short(r.usual)}</>}
                </div>
              </div>
              {i < rows.length - 1 && <span aria-hidden style={{ position: "absolute", left: 62, right: 0, bottom: 0, height: 0.5, background: "var(--sep)" }} />}
            </div>
          );
        })}
      </Group>

      <div style={{ height: 24 }} />
      <SectionHeader trailing={`${short(repeatTotal)} a month`}>What repeats</SectionHeader>
      <Group>
        {repeats.map((r, i) => (
          <div key={r.name} style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, minHeight: 52, padding: `0 ${M}px` }}>
            <EmojiTile emoji={r.emoji} size={30} />
            <span style={{ flex: 1, fontSize: 17 }}>{r.label}</span>
            <span className="subhead l2" style={{ marginRight: 10 }}>{dayMonth(r.next_date)}</span>
            <span style={{ fontSize: 17, fontWeight: 600 }}>{rupees(r.typical_amount)}</span>
            {i < repeats.length - 1 && <span aria-hidden style={{ position: "absolute", left: 58, right: 0, bottom: 0, height: 0.5, background: "var(--sep)" }} />}
          </div>
        ))}
      </Group>
    </Screen>
  );
}
