"use client";

import { ArrowUpRight, Camera, CheckCircle2, FileText, Flashlight, Lock } from "lucide-react";

import { Spark } from "../charts";
import { rupees, short, type IosData } from "../data";
import { Card, Group, InlineNav, M, Screen, STATUS_H, type Theme } from "../kit";

/* -------------------------------------------------------- Statements */

const BANK: Record<string, { name: string; color: string; letter: string }> = {
  sbi: { name: "SBI savings", color: "#2F6BFF", letter: "S" },
  canara: { name: "Canara savings", color: "#FFB020", letter: "C" },
  slice: { name: "slice savings", color: "#7C5CFF", letter: "s" },
  sbi_cc: { name: "SBI Card", color: "#2F6BFF", letter: "S" },
  slice_cc: { name: "slice card", color: "#7C5CFF", letter: "s" },
};

function PdfStack() {
  const sheet = (rot: number, x: number, y: number, label: boolean) => (
    <div style={{ position: "absolute", left: x, top: y, width: 52, height: 64, borderRadius: 9, background: "var(--cell)", boxShadow: "0 0 0 0.5px var(--sep), 0 6px 14px -6px rgba(0,0,0,.25)", transform: `rotate(${rot}deg)`, padding: "10px 8px" }}>
      {[30, 22, 34, 18].map((w, i) => <span key={i} style={{ display: "block", height: 3, width: w, borderRadius: 2, background: "var(--fill-2)", marginBottom: 5 }} />)}
      {label && <span style={{ position: "absolute", left: 6, bottom: 7, padding: "2px 5px", borderRadius: 4, background: "#F0443A", color: "#fff", font: "800 9px/1 var(--sf)", letterSpacing: "0.04em" }}>PDF</span>}
    </div>
  );
  return (
    <div style={{ position: "relative", width: 120, height: 84, margin: "0 auto" }}>
      {sheet(-10, 12, 10, false)}
      {sheet(8, 58, 8, false)}
      {sheet(0, 34, 2, true)}
    </div>
  );
}

export function StatementsScreen({ d, theme }: { d: IosData; theme: Theme }) {
  const ups = d.uploads;
  const txns = ups.reduce((s, u) => s + u.txn_count, 0);
  return (
    <Screen theme={theme} tab="home">
      <InlineNav back="Home" material={false} />
      <div style={{ paddingTop: STATUS_H + 44 }}>
        <h1 className="large-title" style={{ margin: 0, padding: `2px ${M}px 14px` }}>Statements</h1>
        <Card style={{ padding: "24px 20px 22px", textAlign: "center" }}>
          <PdfStack />
          <div className="brand" style={{ fontSize: 24, lineHeight: "29px", marginTop: 18 }}>Add your statements</div>
          <p className="subhead l2" style={{ margin: "8px auto 0", maxWidth: 300 }}>
            Bank and card PDFs. Card bills and self‑transfers are matched, so no rupee counts twice.
          </p>
          <div className="ios-btn" style={{ marginTop: 20 }}><FileText size={18} strokeWidth={2.3} />Choose PDFs</div>
          <div className="footnote l2" style={{ marginTop: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
            <Lock size={12} strokeWidth={2.4} />Read on this device, never shared
          </div>
        </Card>

        <div style={{ display: "flex", justifyContent: "space-between", padding: `24px ${M + 4}px 7px` }}>
          <span className="section-h">{ups.length} statements · Jun to Nov</span>
          <span className="section-h" style={{ textTransform: "none" }}>{txns} transactions</span>
        </div>
        <Group>
          {ups.map((u, i) => {
            const b = BANK[u.bank] ?? { name: u.bank, color: "#A1A1A8", letter: u.bank[0] };
            return (
              <div key={u.id} style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, minHeight: 60, padding: `0 ${M}px` }}>
                <span style={{ width: 34, height: 34, borderRadius: 9, background: b.color, color: "#fff", display: "grid", placeItems: "center", font: "900 16px/1 var(--brand)" }}>{b.letter}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 17 }}>{b.name}</div>
                  <div className="subhead l2">{u.txn_count} transactions · {u.pages_parsed} {u.pages_parsed === 1 ? "page" : "pages"}</div>
                </div>
                <CheckCircle2 size={22} strokeWidth={2.2} style={{ color: "var(--pos)" }} />
                {i < ups.length - 1 && <span aria-hidden style={{ position: "absolute", left: 62, right: 0, bottom: 0, height: 0.5, background: "var(--sep)" }} />}
              </div>
            );
          })}
        </Group>
      </div>
    </Screen>
  );
}

/* -------------------------------------------------------- Lock screen */

export function LockScreen({ d, theme }: { d: IosData; theme: Theme }) {
  const t = d.w.totals;
  const daily = d.w.daily;
  const first = daily[0]?.netWorth ?? t.netWorth;
  const nov = d.monthly.find((m) => m.period === "2026-11");
  const laptop = d.goals.find((g) => g.goal.id === "g-laptop");
  const glass: React.CSSProperties = { background: "rgba(255,255,255,.16)", backdropFilter: "blur(24px) saturate(160%)", WebkitBackdropFilter: "blur(24px) saturate(160%)" };
  const wall = theme === "dark"
    ? "radial-gradient(120% 70% at 15% 10%, #0E4A33 0%, transparent 60%), radial-gradient(90% 60% at 95% 40%, #0B3B4A 0%, transparent 65%), radial-gradient(120% 80% at 50% 110%, #062B1E 0%, transparent 60%), #050807"
    : "radial-gradient(120% 70% at 12% 8%, #2BD487 0%, transparent 58%), radial-gradient(90% 60% at 100% 38%, #00A3BF 0%, transparent 62%), radial-gradient(120% 80% at 40% 108%, #007545 0%, transparent 62%), #0B6E4A";
  const ring = (pct: number, label: React.ReactNode, sub: string) => {
    const r = 29, c = 2 * Math.PI * r;
    return (
      <div style={{ position: "relative", width: 72, height: 72, borderRadius: 36, ...glass, display: "grid", placeItems: "center" }}>
        <svg width={72} height={72} style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}>
          <circle cx={36} cy={36} r={r} fill="none" stroke="rgba(255,255,255,.25)" strokeWidth={5} />
          <circle cx={36} cy={36} r={r} fill="none" stroke="#fff" strokeWidth={5} strokeLinecap="round" strokeDasharray={`${(pct / 100) * c} ${c}`} />
        </svg>
        <div style={{ textAlign: "center", lineHeight: 1 }}>
          <div style={{ font: "700 17px/1 var(--sfd)" }}>{label}</div>
          <div style={{ font: "600 10px/1 var(--sf)", marginTop: 3, opacity: 0.85 }}>{sub}</div>
        </div>
      </div>
    );
  };
  return (
    <Screen theme={theme} bg={wall} statusTone="light" homeColor="#fff">
      <div style={{ position: "absolute", inset: 0, color: "#fff" }}>
        <div style={{ position: "absolute", top: 62, left: 0, right: 0, textAlign: "center" }}>
          <Lock size={16} strokeWidth={2.6} style={{ opacity: 0.9, display: "inline-block" }} />
          <div style={{ font: "600 21px/26px var(--sfd)", marginTop: 6, opacity: 0.92 }}>Friday 20 November</div>
          <div style={{ font: "600 112px/1 ui-rounded, var(--sfd)", letterSpacing: "-3px", marginTop: -2, opacity: 0.96 }}>9:41</div>
        </div>
        {/* widgets */}
        <div style={{ position: "absolute", top: 262, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 12 }}>
          <div style={{ width: 160, height: 72, borderRadius: 20, ...glass, padding: "9px 12px", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ font: "600 12px/14px var(--sf)", opacity: 0.85 }}>Net worth</span>
              <span style={{ font: "600 11px/14px var(--sf)", display: "flex", alignItems: "center" }}><ArrowUpRight size={11} strokeWidth={3} />{short(t.netWorth - first)}</span>
            </div>
            <div style={{ font: "900 22px/26px var(--brand)", letterSpacing: "-0.2px" }}>{short(t.netWorth, 1, true)}</div>
            <Spark values={daily.filter((_, i) => i % 3 === 0).map((p) => p.netWorth)} w={136} h={16} color="#fff" fill={false} />
          </div>
          {nov && ring(nov.rate, `${Math.round(nov.rate)}%`, "saved")}
          {laptop && ring(laptop.status.pct * 100, <span style={{ fontSize: 20 }}>{laptop.emoji}</span>, `${Math.round(laptop.status.pct * 100)}%`)}
        </div>
        {/* notification */}
        <div style={{ position: "absolute", left: 10, right: 10, bottom: 128, borderRadius: 22, padding: "12px 14px", display: "flex", gap: 10, alignItems: "flex-start", ...glass, background: "rgba(255,255,255,.22)" }}>
          <span style={{ width: 38, height: 38, borderRadius: 9, background: "#00B86B", display: "grid", placeItems: "center", font: "900 20px/1 var(--brand)", color: "#fff", boxShadow: "inset 0 -2px 0 #007545", flex: "none" }}>F</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ font: "600 15px/20px var(--sf)" }}>Finance Hub</span>
              <span style={{ font: "400 13px/20px var(--sf)", opacity: 0.75 }}>now</span>
            </div>
            <div style={{ font: "400 15px/20px var(--sf)", opacity: 0.95 }}>
              {nov ? `${rupees(nov.living)} spent so far, about usual by the 20th. ${rupees(nov.saved)} still in the bank.` : ""}
            </div>
          </div>
        </div>
        {/* quick actions */}
        <span style={{ position: "absolute", left: 46, bottom: 46, width: 50, height: 50, borderRadius: 25, ...glass, display: "grid", placeItems: "center" }}><Flashlight size={21} strokeWidth={2} /></span>
        <span style={{ position: "absolute", right: 46, bottom: 46, width: 50, height: 50, borderRadius: 25, ...glass, display: "grid", placeItems: "center" }}><Camera size={21} strokeWidth={2} /></span>
      </div>
    </Screen>
  );
}

