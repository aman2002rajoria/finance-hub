"use client";

/*
 * Finance Hub iOS screens on a Figma-like board.
 *   ?theme=light|dark|both   which row(s) to show (default both)
 *   ?only=home               one phone, for export (add &bare=1 for a transparent page)
 */

import { useEffect, useState, type ReactNode } from "react";

import { useIosData, type IosData } from "./data";
import { IPhone16Pro } from "./device";
import type { Theme } from "./kit";
import { HomeScreen } from "./screens/home";
import { SpendingScreen } from "./screens/spending";
import { InvestmentsScreen, MomentSheetScreen, WealthScreen } from "./screens/wealth";
import { GoalDetailScreen, GoalsScreen } from "./screens/goals";
import { LockScreen, StatementsScreen } from "./screens/extra";
import "./ios.css";

type ScreenFn = (p: { d: IosData; theme: Theme }) => ReactNode;

export const SCREENS: { key: string; label: string; C: ScreenFn }[] = [
  { key: "home", label: "Home", C: HomeScreen },
  { key: "spending", label: "Spending", C: SpendingScreen },
  { key: "wealth", label: "Wealth", C: WealthScreen },
  { key: "moment", label: "Moment sheet", C: MomentSheetScreen },
  { key: "investments", label: "Investments", C: InvestmentsScreen },
  { key: "goals", label: "Goals", C: GoalsScreen },
  { key: "goal", label: "Goal detail", C: GoalDetailScreen },
  { key: "statements", label: "Statements", C: StatementsScreen },
  { key: "lock", label: "Lock screen", C: LockScreen },
];

const num = (i: number) => String(i + 1).padStart(2, "0");

function useParams() {
  const [p, setP] = useState<{ theme: "light" | "dark" | "both"; only: string | null; bare: boolean } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("theme");
    setP({ theme: t === "light" || t === "dark" ? t : "both", only: q.get("only"), bare: q.get("bare") === "1" });
  }, []);
  return p;
}

function Phone({ d, theme, s }: { d: IosData; theme: Theme; s: (typeof SCREENS)[number] }) {
  return (
    <IPhone16Pro finish={theme === "dark" ? "black" : "natural"}>
      <s.C d={d} theme={theme} />
    </IPhone16Pro>
  );
}

function AppMark() {
  return (
    <span aria-hidden style={{ width: 44, height: 44, borderRadius: 13, background: "#00B86B", color: "#fff", display: "grid", placeItems: "center", font: "900 22px/1 var(--font-fira)", boxShadow: "0 3px 0 #007545" }}>F</span>
  );
}

function Board({ d, theme, showTitle }: { d: IosData; theme: Theme; showTitle: boolean }) {
  return (
    <section id={`board-${theme}`} className={`fig-board ${theme === "dark" ? "board-dark" : ""}`} style={{ padding: "88px 96px 112px", width: "max-content", minWidth: "100%" }}>
      {showTitle && (
        <header style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 72, paddingBottom: 28, borderBottom: "1px solid var(--rule)" }}>
          <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
            <AppMark />
            <div>
              <h1 style={{ margin: 0, font: "600 30px/36px -apple-system, Inter, system-ui, sans-serif", letterSpacing: "-0.02em", color: "var(--title)" }}>Finance Hub · iOS</h1>
              <p style={{ margin: "4px 0 0", font: "400 15px/22px -apple-system, Inter, system-ui, sans-serif", color: "var(--sub)" }}>
                Every bank and card statement, turned into one calm picture of what came in, where it went and what it is building.
              </p>
            </div>
          </div>
          <div className="fig-label" style={{ textAlign: "right", fontSize: 12 }}>
            iPhone 16 Pro · 402 × 874 pt · {theme === "dark" ? "Dark" : "Light"} appearance<br />Test data · statements to 20 Nov 2026
          </div>
        </header>
      )}
      <div style={{ display: "flex", gap: 88 }}>
        {SCREENS.map((s, i) => (
          <figure key={s.key} style={{ margin: 0 }}>
            <figcaption className="fig-label" style={{ marginBottom: 14, display: "flex", gap: 6 }}>
              <span style={{ opacity: 0.6 }}>{num(i)}</span><span>{s.label}</span>
            </figcaption>
            <Phone d={d} theme={theme} s={s} />
          </figure>
        ))}
      </div>
    </section>
  );
}

export default function Showcase() {
  const d = useIosData();
  const p = useParams();

  useEffect(() => {
    if (!p?.bare) return;
    const html = document.documentElement, body = document.body;
    const prev = [html.style.background, body.style.background];
    html.style.background = "transparent"; body.style.background = "transparent";
    return () => { html.style.background = prev[0]; body.style.background = prev[1]; };
  }, [p?.bare]);

  if (!p) return null;
  if (!d.ready) {
    return <div className="fig-board" style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}><span className="fig-label">Loading test data…</span></div>;
  }

  if (p.only) {
    const s = SCREENS.find((x) => x.key === p.only) ?? SCREENS[0];
    const theme: Theme = p.theme === "dark" ? "dark" : "light";
    return (
      <div data-ready="1" style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: p.bare ? "transparent" : theme === "dark" ? "#1E1E1E" : "#E5E5E5" }}>
        {/* padding leaves room for the device shadow in the export */}
        <div id="phone" style={{ padding: "48px 64px 96px" }}>
          <Phone d={d} theme={theme} s={s} />
        </div>
      </div>
    );
  }

  const themes: Theme[] = p.theme === "both" ? ["light", "dark"] : [p.theme];
  return (
    <main data-ready="1" style={{ minHeight: "100vh", background: themes[0] === "dark" ? "#1E1E1E" : "#E5E5E5" }}>
      {themes.map((t) => <Board key={t} d={d} theme={t} showTitle />)}
    </main>
  );
}
