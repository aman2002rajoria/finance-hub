"use client";

/*
 * iPhone 16 Pro, drawn in CSS + SVG.
 * Screen 402 x 874 pt, display corner radius 55 pt, Dynamic Island 126 x 37 pt
 * at 11 pt from the top. 4 pt titanium band + 16 pt black border = 20 pt a side,
 * so the device is 442 x 914 (71.5 x 149.6 mm at the same scale, within 1%).
 */

import type { CSSProperties, ReactNode } from "react";

export const SCREEN_W = 402;
export const SCREEN_H = 874;
const BAND = 4;
const BORDER = 16;
const EDGE = BAND + BORDER;
export const DEVICE_W = SCREEN_W + EDGE * 2;
export const DEVICE_H = SCREEN_H + EDGE * 2;
const R = 55;

export type Finish = "natural" | "black";

const FINISH: Record<Finish, { band: string; button: string; hi: string; lo: string }> = {
  natural: {
    band: "linear-gradient(135deg, #C9C5BD 0%, #EAE7E1 22%, #BAB5AC 48%, #E3E0D9 74%, #B2ADA4 100%)",
    button: "linear-gradient(90deg, #A9A49B, #DAD6CF 45%, #ABA69D)",
    hi: "rgba(255,255,255,.55)",
    lo: "rgba(0,0,0,.22)",
  },
  black: {
    band: "linear-gradient(135deg, #3B3B3D 0%, #5A5A5C 22%, #2E2E30 48%, #4D4D50 74%, #2A2A2C 100%)",
    button: "linear-gradient(90deg, #2B2B2D, #545457 45%, #2B2B2D)",
    hi: "rgba(255,255,255,.18)",
    lo: "rgba(0,0,0,.5)",
  },
};

function SideButton({ side, top, h, finish, flush }: { side: "l" | "r"; top: number; h: number; finish: Finish; flush?: boolean }) {
  const f = FINISH[finish];
  const w = flush ? 2 : 3.5;
  const style: CSSProperties = {
    position: "absolute", top, height: h, width: w + 2,
    [side === "l" ? "left" : "right"]: -w,
    background: flush ? (finish === "natural" ? "linear-gradient(90deg,#8E8A83,#B9B5AE)" : "linear-gradient(90deg,#1A1A1B,#3A3A3C)") : f.button,
    borderRadius: side === "l" ? "2px 0 0 2px" : "0 2px 2px 0",
    boxShadow: `inset 0 1px 0 ${f.hi}, inset 0 -1px 0 ${f.lo}`,
  };
  return <span aria-hidden style={style} />;
}

export function IPhone16Pro({ children, finish = "natural", shadow = true }: { children: ReactNode; finish?: Finish; shadow?: boolean }) {
  const f = FINISH[finish];
  return (
    <div style={{ position: "relative", width: DEVICE_W, height: DEVICE_H, flex: "none" }}>
      {/* left: Action button, volume up, volume down */}
      <SideButton side="l" top={196} h={34} finish={finish} />
      <SideButton side="l" top={268} h={64} finish={finish} />
      <SideButton side="l" top={346} h={64} finish={finish} />
      {/* right: side button, Camera Control (flush sapphire) */}
      <SideButton side="r" top={292} h={102} finish={finish} />
      <SideButton side="r" top={556} h={58} finish={finish} flush />

      <div
        style={{
          position: "absolute", inset: 0, borderRadius: R + EDGE, padding: BAND, background: f.band,
          boxShadow: [
            `inset 0 0 0 0.75px ${f.lo}`,
            `inset 0 1.5px 1px ${f.hi}`,
            shadow ? "0 1px 2px rgba(0,0,0,.12), 0 18px 36px -14px rgba(0,0,0,.28), 0 48px 90px -40px rgba(0,0,0,.38)" : "",
          ].filter(Boolean).join(", "),
        }}
      >
        <div style={{ width: "100%", height: "100%", borderRadius: R + BORDER, background: "#050506", padding: BORDER, boxShadow: "inset 0 0 0 1px rgba(255,255,255,.05)" }}>
          <div style={{ position: "relative", width: SCREEN_W, height: SCREEN_H, borderRadius: R, overflow: "hidden", isolation: "isolate" }}>
            {children}
            {/* Dynamic Island */}
            <div aria-hidden style={{ position: "absolute", top: 11, left: (SCREEN_W - 126) / 2, width: 126, height: 37, borderRadius: 18.5, background: "#000", zIndex: 50 }}>
              <span style={{ position: "absolute", right: 23, top: 12.5, width: 12, height: 12, borderRadius: 6, background: "radial-gradient(circle at 40% 35%, #2A2F45 0 18%, #0C0E16 45%, #050507 70%)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.04)" }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
