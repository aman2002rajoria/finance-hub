"use client";

/*
 * Native-feeling iOS building blocks: status bar, nav bars, tab bar,
 * segmented control, inset grouped lists, chips. Sizes follow the HIG
 * (17pt body, 34pt large titles, 44pt rows, 16pt margins, 83pt tab bar).
 */

import type { CSSProperties, ReactNode } from "react";
import { ChevronLeft, ChevronRight, Goal, House, PiggyBank, ReceiptText, type LucideIcon } from "lucide-react";

import { SCREEN_H, SCREEN_W } from "./device";

export type Theme = "light" | "dark";
export type Tab = "home" | "spending" | "wealth" | "goals";

export const M = 16;              // side margin
export const STATUS_H = 62;       // status bar + island safe area on 16 Pro
export const TAB_H = 83;          // 49 + 34 home indicator

/* ------------------------------------------------------- status bar */

export function StatusBar({ tone = "auto" }: { tone?: "auto" | "light" }) {
  const c = tone === "light" ? "#fff" : "var(--l1)";
  return (
    <div aria-hidden style={{ position: "absolute", top: 0, left: 0, right: 0, height: 54, zIndex: 40, color: c, pointerEvents: "none" }}>
      <span style={{ position: "absolute", left: 0, width: 138, top: 17, textAlign: "center", paddingLeft: 14, font: "600 17px/22px var(--sfd)", letterSpacing: "-0.4px" }}>9:41</span>
      <div style={{ position: "absolute", right: 0, width: 138, top: 23, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, paddingRight: 12 }}>
        {/* cellular */}
        <svg width="19" height="12" viewBox="0 0 19 12" fill={c}>
          <rect x="0" y="7.5" width="3.2" height="4.5" rx="1" />
          <rect x="5.1" y="5.2" width="3.2" height="6.8" rx="1" />
          <rect x="10.2" y="2.7" width="3.2" height="9.3" rx="1" />
          <rect x="15.3" y="0" width="3.2" height="12" rx="1" />
        </svg>
        {/* wi-fi */}
        <svg width="17" height="12" viewBox="0 0 17 12" fill={c}>
          <path d="M8.5 2.3c2.3 0 4.4.9 6 2.4.1.1.3.1.4 0l1.2-1.2c.1-.1.1-.3 0-.4C14.1 1.2 11.4 0 8.5 0S2.9 1.2.9 3.1c-.1.1-.1.3 0 .4l1.2 1.2c.1.1.3.1.4 0 1.6-1.5 3.7-2.4 6-2.4z" />
          <path d="M8.5 6.1c1.3 0 2.4.5 3.3 1.3.1.1.3.1.4 0l1.2-1.2c.1-.1.1-.3 0-.4-1.3-1.2-3-1.9-4.9-1.9s-3.6.7-4.9 1.9c-.1.1-.1.3 0 .4l1.2 1.2c.1.1.3.1.4 0 .9-.8 2-1.3 3.3-1.3z" />
          <path d="M10.8 9.1c.1-.1.1-.3 0-.4-.6-.5-1.4-.8-2.3-.8s-1.7.3-2.3.8c-.1.1-.1.3 0 .4l2.1 2.1c.1.1.3.1.4 0l2.1-2.1z" />
        </svg>
        {/* battery */}
        <svg width="28" height="13" viewBox="0 0 28 13">
          <rect x="0.5" y="0.5" width="24" height="12" rx="3.8" fill="none" stroke={c} strokeOpacity=".36" />
          <rect x="2" y="2" width="21" height="9" rx="2.5" fill={c} />
          <path d="M26 4.4v4.2c.8-.3 1.4-1.1 1.4-2.1s-.6-1.8-1.4-2.1z" fill={c} fillOpacity=".4" />
        </svg>
      </div>
    </div>
  );
}

export function HomeIndicator({ color }: { color?: string }) {
  return <span aria-hidden style={{ position: "absolute", bottom: 8, left: (SCREEN_W - 139) / 2, width: 139, height: 5, borderRadius: 3, background: color ?? "var(--home)", zIndex: 60 }} />;
}

/* ---------------------------------------------------------- tab bar */

const TABS: { key: Tab; label: string; Icon: LucideIcon }[] = [
  { key: "home", label: "Home", Icon: House },
  { key: "spending", label: "Spending", Icon: ReceiptText },
  { key: "wealth", label: "Wealth", Icon: PiggyBank },
  { key: "goals", label: "Goals", Icon: Goal },
];

export function TabBar({ active }: { active: Tab }) {
  return (
    <nav aria-label="Tabs" style={{
      position: "absolute", left: 0, right: 0, bottom: 0, height: TAB_H, zIndex: 30,
      background: "var(--bar)", backdropFilter: "blur(20px) saturate(180%)", WebkitBackdropFilter: "blur(20px) saturate(180%)",
      boxShadow: "inset 0 0.5px 0 var(--bar-line)",
    }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", height: 49, paddingTop: 7 }}>
        {TABS.map(({ key, label, Icon }) => {
          const on = key === active;
          return (
            <div key={key} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, color: on ? "var(--tint)" : "rgba(153,153,153,1)" }}>
              <Icon size={25} strokeWidth={on ? 2.2 : 1.7} fill={on ? "currentColor" : "none"} fillOpacity={on ? 0.16 : 0} />
              <span style={{ font: "500 10px/12px var(--sf)", letterSpacing: "0.1px" }}>{label}</span>
            </div>
          );
        })}
      </div>
    </nav>
  );
}

/* ------------------------------------------------------- the screen */

export function Screen({ theme, tab, children, bg, statusTone, homeColor }: { theme: Theme; tab?: Tab; children: ReactNode; bg?: string; statusTone?: "auto" | "light"; homeColor?: string }) {
  return (
    <div className={`ios-screen ios-${theme}`} style={{ position: "absolute", inset: 0, width: SCREEN_W, height: SCREEN_H, background: bg ?? "var(--grouped)", overflow: "hidden" }}>
      <StatusBar tone={statusTone} />
      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>{children}</div>
      {tab && <TabBar active={tab} />}
      <HomeIndicator color={homeColor} />
    </div>
  );
}

/** Large-title nav bar (expanded): 44pt bar for buttons, then the 34pt title. */
export function LargeTitle({ title, trailing, leading }: { title: string; trailing?: ReactNode; leading?: ReactNode }) {
  return (
    <div style={{ paddingTop: STATUS_H }}>
      <div style={{ height: 44, display: "flex", alignItems: "center", justifyContent: "space-between", padding: `0 ${M}px` }}>
        <div>{leading}</div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>{trailing}</div>
      </div>
      <h1 className="large-title" style={{ margin: 0, padding: `2px ${M}px 8px` }}>{title}</h1>
    </div>
  );
}

/** Collapsed (inline) nav bar with a back button, over a material when scrolled. */
export function InlineNav({ back, title, trailing, material = true }: { back?: string; title?: string; trailing?: ReactNode; material?: boolean }) {
  return (
    <div style={{
      position: "absolute", top: 0, left: 0, right: 0, height: STATUS_H + 44, zIndex: 20,
      background: material ? "var(--bar)" : "transparent",
      backdropFilter: material ? "blur(20px) saturate(180%)" : undefined, WebkitBackdropFilter: material ? "blur(20px) saturate(180%)" : undefined,
      boxShadow: material ? "inset 0 -0.5px 0 var(--bar-line)" : undefined,
    }}>
      <div style={{ position: "absolute", top: STATUS_H, left: 0, right: 0, height: 44, display: "flex", alignItems: "center" }}>
        {back && (
          <span className="tint" style={{ display: "flex", alignItems: "center", paddingLeft: 8, gap: 1 }}>
            <ChevronLeft size={30} strokeWidth={2.1} style={{ marginRight: -3 }} />
            <span style={{ fontSize: 17 }}>{back}</span>
          </span>
        )}
        {title && <span style={{ position: "absolute", left: 0, right: 0, textAlign: "center", font: "600 17px/22px var(--sf)", letterSpacing: "-0.41px", pointerEvents: "none" }}>{title}</span>}
        <span style={{ marginLeft: "auto", paddingRight: M, display: "flex", gap: 16, alignItems: "center" }}>{trailing}</span>
      </div>
    </div>
  );
}

/** Circular glass button for nav bars (iOS 18 style). */
export function NavCircle({ children, label }: { children: ReactNode; label: string }) {
  return (
    <span aria-label={label} style={{ width: 34, height: 34, borderRadius: 17, display: "grid", placeItems: "center", background: "var(--fill)", color: "var(--tint)" }}>
      {children}
    </span>
  );
}

/* ---------------------------------------------- segmented, chips */

export function Segmented({ items, active, style }: { items: string[]; active: number; style?: CSSProperties }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${items.length}, 1fr)`, background: "var(--fill)", borderRadius: 9, padding: 2, height: 32, ...style }}>
      {items.map((t, i) => (
        <span key={t} style={{
          display: "grid", placeItems: "center", borderRadius: 7, font: `${i === active ? 600 : 500} 13px/18px var(--sf)`, letterSpacing: "-0.08px",
          background: i === active ? "var(--seg-on, #fff)" : "transparent",
          boxShadow: i === active ? "0 3px 8px rgba(0,0,0,.12), 0 3px 1px rgba(0,0,0,.04), 0 0 0 0.5px rgba(0,0,0,.04)" : undefined,
          borderLeft: i > 0 && i !== active && i - 1 !== active ? "0.5px solid var(--sep)" : "0.5px solid transparent",
        }} className="seg">{t}</span>
      ))}
    </div>
  );
}

export function Chip({ children, tone = "plain", style }: { children: ReactNode; tone?: "plain" | "tint" | "warn" | "neg" | "pos"; style?: CSSProperties }) {
  const bg = { plain: "var(--fill)", tint: "var(--tint-soft)", warn: "var(--warn-soft)", neg: "var(--neg-soft)", pos: "var(--pos-soft)" }[tone];
  const fg = { plain: "var(--l1)", tint: "var(--tint-ink)", warn: "var(--warn)", neg: "var(--neg)", pos: "var(--pos)" }[tone];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, height: 26, padding: "0 10px", borderRadius: 13, background: bg, color: fg, font: "600 13px/18px var(--sf)", letterSpacing: "-0.08px", whiteSpace: "nowrap", ...style }}>
      {children}
    </span>
  );
}

/* --------------------------------------------- inset grouped lists */

export function SectionHeader({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: `0 ${M + 4}px 7px` }}>
      <span style={{ font: "900 20px/25px var(--brand)", letterSpacing: "-0.2px" }}>{children}</span>
      {trailing && <span className="tint subhead">{trailing}</span>}
    </div>
  );
}

export function Group({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ margin: `0 ${M}px`, borderRadius: 14, background: "var(--cell)", overflow: "hidden", boxShadow: "var(--shadow-card)", ...style }}>{children}</div>;
}

export function Row({ icon, title, sub, value, valueSub, chevron, last, inset = 60, minH = 44, valueColor }: {
  icon?: ReactNode; title: ReactNode; sub?: ReactNode; value?: ReactNode; valueSub?: ReactNode;
  chevron?: boolean; last?: boolean; inset?: number; minH?: number; valueColor?: string;
}) {
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", minHeight: minH, padding: `${sub ? 10 : 11}px ${M}px`, gap: 12 }}>
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 17, lineHeight: "22px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        {sub && <div className="subhead l2" style={{ marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: 4 }}>{sub}</div>}
      </div>
      {(value != null || valueSub != null) && (
        <div style={{ textAlign: "right", flex: "none" }}>
          {value != null && <div style={{ fontSize: 17, lineHeight: "22px", color: valueColor }}>{value}</div>}
          {valueSub != null && <div className="subhead" style={{ marginTop: 1 }}>{valueSub}</div>}
        </div>
      )}
      {chevron && <ChevronRight size={18} strokeWidth={2.4} style={{ color: "var(--l3)", marginRight: -4, flex: "none" }} />}
      {!last && <span aria-hidden style={{ position: "absolute", left: inset, right: 0, bottom: 0, height: 0.5, background: "var(--sep)" }} />}
    </div>
  );
}

/** Rounded-square emoji tile, like a Settings icon. */
export function EmojiTile({ emoji, size = 32, bg = "var(--fill)" }: { emoji: string; size?: number; bg?: string }) {
  return (
    <span aria-hidden style={{ width: size, height: size, borderRadius: Math.round(size * 0.27), background: bg, display: "grid", placeItems: "center", fontSize: Math.round(size * 0.56), lineHeight: 1, flex: "none" }}>
      {emoji}
    </span>
  );
}

/** A plain card (inset, 16pt padding). */
export function Card({ children, style, pad = 16 }: { children: ReactNode; style?: CSSProperties; pad?: number }) {
  return <div style={{ margin: `0 ${M}px`, borderRadius: 18, background: "var(--cell)", padding: pad, boxShadow: "var(--shadow-card)", ...style }}>{children}</div>;
}

/* ------------------------------------------------------ chart utils */

export interface Pt { x: number; y: number }

/** Smooth path through points (monotone-ish cubic). */
export function smooth(pts: Pt[]): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 2] ?? pts[i - 1], p1 = pts[i - 1], p2 = pts[i], p3 = pts[i + 1] ?? p2;
    const t = 0.18;
    const c1x = p1.x + (p2.x - p0.x) * t, c1y = p1.y + (p2.y - p0.y) * t;
    const c2x = p2.x - (p3.x - p1.x) * t, c2y = p2.y - (p3.y - p1.y) * t;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

/** Thin a long series to about n points, keeping the first, last and extremes per bucket. */
export function thin<T>(xs: T[], n: number, val: (t: T) => number): T[] {
  if (xs.length <= n) return xs;
  const out: T[] = [];
  const size = xs.length / n;
  for (let i = 0; i < n; i++) {
    const b = xs.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    if (!b.length) continue;
    // keep the bucket's most extreme point vs its neighbours' mean, so dips survive
    const mean = b.reduce((s, x) => s + val(x), 0) / b.length;
    out.push(b.reduce((best, x) => (Math.abs(val(x) - mean) > Math.abs(val(best) - mean) ? x : best), b[0]));
  }
  if (out[out.length - 1] !== xs[xs.length - 1]) out.push(xs[xs.length - 1]);
  if (out[0] !== xs[0]) out.unshift(xs[0]);
  return out;
}

export const scale = (d0: number, d1: number, r0: number, r1: number) => (v: number) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
