"use client";

/*
 * App frame (design.md §7 top bar + navigation, §16 test data mode, §18 mobile).
 *
 * Four sections: Home, Spending, Wealth, Goals. Desktop (1024px and up) shows
 * them as a segmented pill nav in the sticky 64px top bar; below that they move
 * to a 4-tab bottom bar. Upload and Settings are header actions on every size,
 * beside the TEST DATA badge and the theme toggle. /categorize (unlinked) lights
 * Spending; /rules lights the Settings gear.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft, ArrowRight, ChevronDown, House, Moon, PiggyBank, ReceiptText,
  RotateCcw, Settings, Sun, Target, Upload, type LucideIcon,
} from "lucide-react";
import clsx from "clsx";
import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

import { Badge, Button, IllustrationSlot } from "@/components/ui";
import { setDataMode, TEST_ONLY, useDataMode, apiPrefix } from "@/lib/dataMode";
import { wealth } from "@/lib/wealth";
import { setTheme, useResolvedTheme } from "@/lib/theme";

type NavItem = { href: string; label: string; Icon: LucideIcon; match?: string[] };

const PRIMARY: NavItem[] = [
  { href: "/",             label: "Home",     Icon: House },
  { href: "/transactions", label: "Spending", Icon: ReceiptText, match: ["/transactions", "/categorize"] },
  { href: "/wealth",       label: "Wealth",   Icon: PiggyBank },
  { href: "/goals",        label: "Goals",    Icon: Target },
];

const PORTFOLIO_URL = process.env.NEXT_PUBLIC_PORTFOLIO_URL;
const CASE_STUDY_URL = process.env.NEXT_PUBLIC_CASE_STUDY_URL;

function matches(pathname: string, item: NavItem) {
  const bases = item.match ?? [item.href];
  return bases.some(b => (b === "/" ? pathname === "/" : pathname === b || pathname.startsWith(`${b}/`)));
}

function useIsActive() {
  const pathname = usePathname() ?? "";
  return (item: NavItem) => matches(pathname, item);
}

function useClickOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

// ---------------------------------------------------------------------------
// App mark: 32px accent square, 10px radius, white 900 letter, 3px lip.
// ---------------------------------------------------------------------------

export function AppMark({ size = 32 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center bg-accent-500 font-black text-white"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.31),
        fontSize: Math.round(size * 0.5),
        boxShadow: "0 3px 0 rgb(0 117 69)",
      }}
    >
      F
    </span>
  );
}

// ---------------------------------------------------------------------------
// Top navigation: segmented pills with a sliding active pill (§7, §14)
// ---------------------------------------------------------------------------

function TopNav() {
  const isActive = useIsActive();
  return (
    <nav aria-label="Main navigation" className="hidden items-center gap-1 rounded-pill bg-surface p-1 lg:flex">
      {PRIMARY.map(item => {
        const active = isActive(item);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "relative rounded-pill px-3.5 py-2 text-sm font-semibold transition-colors duration-200 xl:px-4",
              active ? "text-ink" : "text-muted hover:text-ink",
            )}
          >
            {active && (
              <motion.span
                layoutId="topnav-active"
                aria-hidden
                className="absolute inset-0 rounded-pill bg-card shadow-[0_0_0_1px_var(--line),0_1px_0_var(--surface-2)]"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            )}
            <span className="relative flex items-center gap-2">
              <item.Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

/** Upload (ghost, icon + label) and the Settings gear, in the header on every size. */
function HeaderActions() {
  const pathname = usePathname() ?? "";
  const onUpload = pathname.startsWith("/upload");
  const onSettings = pathname.startsWith("/settings") || pathname.startsWith("/rules");
  return (
    <>
      <Link
        href="/upload"
        aria-label="Upload statements"
        title="Upload statements"
        aria-current={onUpload ? "page" : undefined}
        className={clsx("btn ghost sm !mb-1 max-md:!h-[34px] max-md:!w-[34px] max-md:!p-0", onUpload && "!bg-surface !text-ink")}
      >
        <Upload className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        <span className="hidden md:inline">Upload</span>
      </Link>
      <Link
        href="/settings"
        aria-label="Settings"
        title="Settings"
        aria-current={onSettings ? "page" : undefined}
        className={clsx("btn ghost icon sm !mb-1", onSettings && "!bg-surface !text-ink")}
      >
        <Settings className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
      </Link>
    </>
  );
}

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------

function ThemeToggle() {
  const theme = useResolvedTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className="btn ghost icon sm !mb-1"
    >
      {theme === "dark"
        ? <Sun className="h-[18px] w-[18px]" strokeWidth={1.75} />
        : <Moon className="h-[18px] w-[18px]" strokeWidth={1.75} />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// TEST DATA badge with its menu (§16)
// ---------------------------------------------------------------------------

function TestDataMenu() {
  const [open, setOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ref = useClickOutside(open, () => setOpen(false));

  async function reset() {
    setResetting(true);
    setNote(null);
    try {
      const r = await fetch(`${apiPrefix()}/system/reset-demo`, { method: "POST" });
      if (!r.ok) throw new Error(String(r.status));
      wealth.resetDemo();
      window.location.reload();
    } catch {
      setNote("Couldn't reset right now. The test data is unchanged.");
      setResetting(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-pill bg-warning-tint py-1 pl-1 pr-2 text-warning-text transition-opacity hover:opacity-85"
      >
        <Badge tone="warning" className="!bg-transparent">Test data</Badge>
        <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+10px)] z-50 w-72 rounded-m bg-card p-2 shadow-float">
          <p className="px-3 pb-2 pt-2 text-sm text-muted">
            You're looking at sample statements. Changes you make here stay in the test data.
          </p>
          {!TEST_ONLY && (
            <button
              role="menuitem"
              type="button"
              onClick={() => setDataMode("own")}
              className="flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 text-left text-[15px] font-semibold text-ink hover:bg-surface"
            >
              <ArrowRight className="h-4 w-4 text-muted" strokeWidth={1.75} />
              Switch to my own data
            </button>
          )}
          <button
            role="menuitem"
            type="button"
            onClick={reset}
            disabled={resetting}
            className="flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 text-left text-[15px] font-semibold text-ink hover:bg-surface disabled:opacity-50"
          >
            <RotateCcw className="h-4 w-4 text-muted" strokeWidth={1.75} />
            {resetting ? "Resetting test data…" : "Reset test data"}
          </button>
          {note && <p className="px-3 pb-2 pt-1 text-sm text-danger-text">{note}</p>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top bar (§7, ref 08)
// ---------------------------------------------------------------------------

function TopBar({ testMode, showNav }: { testMode: boolean; showNav: boolean }) {
  return (
    <header className="sticky top-0 z-40 h-16 border-b border-line bg-[var(--topbar)] backdrop-blur-[16px]">
      <div className="mx-auto flex h-full max-w-[calc(1320px+2*var(--gutter))] items-center gap-4 px-[var(--gutter)]">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {PORTFOLIO_URL && (
            <a href={PORTFOLIO_URL} className="btn ghost icon sm !mb-1" aria-label="Back to Aman's portfolio" title="Back to Aman's portfolio">
              <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
            </a>
          )}
          <Link href="/" className="flex min-w-0 items-center gap-3 rounded-[12px]">
            <AppMark />
            <span className={clsx("truncate text-[20px] font-black leading-none text-ink", showNav && "hidden min-[440px]:inline lg:hidden xl:inline")}>Finance Hub</span>
          </Link>
        </div>
        {showNav && <TopNav />}
        <div className="flex flex-1 items-center justify-end gap-1.5 sm:gap-2.5">
          {testMode && <TestDataMenu />}
          {showNav && <HeaderActions />}
          <ThemeToggle />
          {CASE_STUDY_URL && (
            <a href={CASE_STUDY_URL} className="btn ghost sm !mb-1 hidden xl:inline-flex">
              How I built it
              <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
            </a>
          )}
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Mobile bottom tab bar
// ---------------------------------------------------------------------------

function BottomTabs() {
  const isActive = useIsActive();
  return (
    <nav
      aria-label="Main navigation"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-[var(--topbar)] pb-[env(safe-area-inset-bottom)] backdrop-blur-[16px] lg:hidden"
    >
      <ul className="grid grid-cols-4">
        {PRIMARY.map(item => {
          const active = isActive(item);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={clsx(
                  "flex min-h-[64px] flex-col items-center justify-center gap-1 text-[12px] font-semibold",
                  active ? "text-accent-700" : "text-muted",
                )}
              >
                <item.Icon className="h-5 w-5" strokeWidth={active ? 2.25 : 1.75} />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// First screen: own data or test data (§16)
// ---------------------------------------------------------------------------

function ChooseData() {
  return (
    <div className="flex min-h-[calc(100vh-64px)] items-center justify-center px-[var(--gutter)] py-16">
      <div className="rise-in flex max-w-[620px] flex-col items-center text-center">
        <IllustrationSlot label="coin jar with a leaf" size={152} />
        <p className="eyebrow mt-8 text-muted">Finance Hub</p>
        <h1 className="mt-3 text-[36px] font-black leading-[1.08] tracking-[-0.01em] text-ink md:text-[44px]">
          Every statement, one calm picture
        </h1>
        <p className="mt-4 max-w-[52ch] text-body-l text-ink-2">
          Drop in your bank and card statements. Finance Hub parses them, matches card bills and
          self-transfers so no rupee is counted twice, and shows what you really spent.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button variant="primary" size="lg" onClick={() => setDataMode("own")}>
            Use my own data
          </Button>
          <Button variant="ghost" size="lg" onClick={() => setDataMode("test")}>
            Try with test data
          </Button>
        </div>
        <p className="mt-3 text-sm text-muted">
          Test data is six months of sample statements. Nothing you do there touches your own.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/** /showcase/* renders bare (no top bar, tabs or data gate) on test data. */
function useShowcase(): boolean {
  const pathname = usePathname() ?? "";
  const on = pathname === "/showcase" || pathname.startsWith("/showcase/");
  if (on && typeof window !== "undefined") {
    try { if (window.localStorage.getItem("fh-data-mode") !== "test") window.localStorage.setItem("fh-data-mode", "test"); } catch { /* blocked */ }
  }
  return on;
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const showcase = useShowcase();
  const mode = useDataMode();
  const theme = useResolvedTheme();

  if (showcase) return <>{children}</>;

  if (mode === "pending") {
    // Server render / first paint: hold the frame so the gate never flashes.
    return <div className="min-h-screen bg-bg" />;
  }

  if (mode === null) {
    return (
      <div className="min-h-screen bg-bg">
        <TopBar testMode={false} showNav={false} />
        <ChooseData />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg">
      <TopBar testMode={mode === "test"} showNav />
      {/* Keyed by theme so charts (which can't read CSS vars) redraw in the new palette. */}
      <main key={theme} className="pb-28 lg:pb-20">
        <div className="page-shell pt-8 md:pt-12">{children}</div>
      </main>
      <BottomTabs />
    </div>
  );
}
