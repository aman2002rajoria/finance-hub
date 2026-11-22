"use client";

import { ArrowUpRight, Upload } from "lucide-react";

import { NetWorthChart } from "../charts";
import { SHOW_MONTH, monthName, rupees, short, type IosData } from "../data";
import { Card, Chip, LargeTitle, M, NavCircle, Screen, type Theme } from "../kit";

function Tile({ label, value, sub, valueColor, children }: { label: string; value: string; sub: React.ReactNode; valueColor?: string; children?: React.ReactNode }) {
  return (
    <div style={{ background: "var(--cell)", borderRadius: 18, padding: "14px 14px 13px", minHeight: 96, display: "flex", flexDirection: "column", boxShadow: "var(--shadow-card)" }}>
      <span className="footnote l2" style={{ fontWeight: 500 }}>{label}</span>
      <span className="brand" style={{ fontSize: 24, lineHeight: "30px", marginTop: 4, color: valueColor }}>{value}</span>
      <span className="footnote l2" style={{ marginTop: "auto", display: "flex", alignItems: "center", gap: 3 }}>{sub}</span>
      {children}
    </div>
  );
}

export function HomeScreen({ d, theme }: { d: IosData; theme: Theme }) {
  const cur = d.cur!;
  const u = d.w.usual;
  const nw = d.w.totals.netWorth;
  const first = d.w.daily[0]?.netWorth ?? nw;
  const months = d.monthly.map((m) => m.period);
  const bonus = d.oneOffs.find((o) => o.kind === "income");
  const big = d.oneOffs.find((o) => o.kind === "spend");
  return (
    <Screen theme={theme} tab="home">
      <LargeTitle
        title="Home"
        trailing={<><NavCircle label="Upload statements"><Upload size={17} strokeWidth={2.2} /></NavCircle>
          <span aria-hidden style={{ width: 34, height: 34, borderRadius: 17, background: "linear-gradient(135deg,#00B86B,#007545)", color: "#fff", display: "grid", placeItems: "center", font: "900 15px/1 var(--brand)" }}>A</span></>}
      />
      {/* month chips */}
      <div style={{ display: "flex", gap: 8, padding: `4px ${M}px 0`, overflow: "hidden" }}>
        {months.slice(1).map((p) => {
          const on = p === SHOW_MONTH;
          const label = p === "2026-11" ? "Nov so far" : monthName(p);
          return (
            <span key={p} style={{ height: 32, padding: "0 14px", borderRadius: 16, display: "grid", placeItems: "center", font: `${on ? 600 : 500} 15px/1 var(--sf)`, letterSpacing: "-0.24px", background: on ? "var(--l1)" : "var(--cell)", color: on ? "var(--grouped)" : "var(--l1)", boxShadow: on ? undefined : "inset 0 0 0 0.5px var(--sep)" }}>{label}</span>
          );
        })}
      </div>

      <div style={{ padding: `20px ${M + 4}px 0` }}>
        <div className="brand" style={{ fontSize: 32, lineHeight: "36px" }}>{short(cur.income)} came in</div>
        <div className="brand" style={{ fontSize: 32, lineHeight: "38px", color: "var(--tint)" }}>{Math.round(cur.rate)}% saved or invested</div>
        <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
          {bonus && <Chip>incl. {bonus.emoji} {short(bonus.amount)} bonus</Chip>}
          {big && <Chip>incl. {big.emoji} {short(big.amount)} iPad</Chip>}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, padding: `18px ${M}px 0` }}>
        <Tile label="Spent" value={rupees(cur.living)} sub={<>Usual {short(u.spend, 0)}</>} />
        <Tile label="🏦 Saved in bank" value={rupees(cur.saved)} valueColor="var(--tint)" sub={<>Usual {short(u.surplus)}</>} />
        <Tile label="📈 Invested" value={rupees(cur.invest)} valueColor="var(--tint)" sub="Same as usual" />
        <Tile label="Net worth" value={short(nw, 1, true)} sub={<><ArrowUpRight size={13} strokeWidth={2.4} style={{ color: "var(--pos)" }} /><span style={{ color: "var(--pos)", fontWeight: 600 }}>{short(nw - first)}</span> since Jun</>} />
      </div>

      <Card pad={0} style={{ marginTop: 10, paddingTop: 4, overflow: "hidden" }}>
        <div style={{ padding: "10px 16px 0", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ font: "900 18px/22px var(--brand)" }}>Moments</span>
          <span className="subhead l2">Net worth since 1 Jun</span>
        </div>
        <div style={{ padding: "0 14px 10px" }}>
          <NetWorthChart daily={d.w.daily} markers={d.w.markers} w={342} h={172} top={34} pinSize={24} kinds={["event", "income", "spend"]} />
        </div>
      </Card>

    </Screen>
  );
}
