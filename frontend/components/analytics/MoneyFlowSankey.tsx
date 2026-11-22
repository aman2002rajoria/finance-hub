"use client";

import clsx from "clsx";
import {
  Maximize2, Minimize2, Minus, Plus, RotateCcw, ZoomIn, ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Button, Card, CardTitle, Chip, EmptyState, ErrorCard, IconButton, Segmented, Skeleton,
} from "@/components/ui";
import { useSankey } from "@/lib/api";
import { inr } from "@/lib/format";
import type { SankeyData, SankeyMode, SankeyNode } from "@/lib/types";

import { errorMessage } from "./cardStates";
import { useDateRange } from "./DateRangeProvider";
import { categoryLabel, monthYear } from "./fmt";
import {
  collapseOneLevel,
  descendantsOf,
  expandAll,
  expandOneLevel,
  layoutSankey,
  pathLinkIds,
  type LayoutLink,
  type LayoutNode,
} from "./sankeyLayout";
import {
  isTimelineHubNode,
  layoutTimelineSankey,
  monthShort,
  TIMELINE_COL_GAP,
  TIMELINE_COL_W,
  TIMELINE_PAD,
} from "./sankeyTimelineLayout";
import { expenseColor, linkColors, nodeTheme, SANKEY_COLORS } from "./sankeyTheme";

type TooltipState =
  | { kind: "node"; node: LayoutNode; x: number; y: number }
  | { kind: "link"; link: LayoutLink; source: LayoutNode; target: LayoutNode; x: number; y: number }
  | null;

const MODES: { value: SankeyMode; label: string }[] = [
  { value: "timeline", label: "Month by month" },
  { value: "period", label: "Whole range" },
  { value: "monthly", label: "Detailed" },
];

const TITLE = "How money moved";

export default function MoneyFlowSankey() {
  const { dr } = useDateRange();
  const [mode, setMode] = useState<SankeyMode>("timeline");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const expandedList = useMemo(() => [...expanded].sort(), [expanded]);
  const { data, error, isLoading, mutate } = useSankey(dr, { mode, expanded: expandedList });

  const toggleNode = useCallback((node: SankeyNode, allNodes: SankeyNode[]) => {
    if (!node.expandable) return;
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(node.id)) {
        next.delete(node.id);
        for (const d of descendantsOf(allNodes, node.id)) next.delete(d);
      } else {
        let cur: SankeyNode | undefined = node;
        while (cur) {
          next.add(cur.id);
          cur = cur.parent_id
            ? allNodes.find(n => n.id === cur!.parent_id)
            : undefined;
        }
      }
      return next;
    });
  }, []);

  if (error && !isLoading && !data) {
    return (
      <ErrorCard
        title="The money flow didn't load"
        message={errorMessage(error, "the money flow")}
        onRetry={() => mutate()}
      />
    );
  }

  if (!data) {
    return (
      <Card>
        <CardTitle subtitle="Income in, spending out, and what carried over">{TITLE}</CardTitle>
        <div className="mt-5" aria-busy="true" aria-label="Loading the money flow">
          <div className="flex gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex flex-1 flex-col gap-3 rounded-s p-3 shadow-flat">
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ))}
          </div>
        </div>
      </Card>
    );
  }

  if (!data.nodes?.length) {
    return (
      <Card>
        <CardTitle>{TITLE}</CardTitle>
        <EmptyState
          compact
          illustration="stack of statements"
          title="Not enough to draw yet"
          hint="The flow appears once this range has both money coming in and going out."
        />
      </Card>
    );
  }

  return (
    <SankeyCard
      data={data}
      mode={mode}
      onModeChange={m => { setMode(m); setExpanded(new Set()); }}
      expanded={expanded}
      onToggle={toggleNode}
      onExpandOne={() => setExpanded(expandOneLevel(data.nodes, expanded))}
      onCollapseOne={() => setExpanded(collapseOneLevel(data.nodes, expanded))}
      onExpandAll={() => setExpanded(expandAll(data.nodes))}
      onCollapseAll={() => setExpanded(new Set())}
      onReset={() => { setExpanded(new Set()); setMode("timeline"); }}
    />
  );
}

function SankeyCard({
  data, mode, onModeChange, expanded, onToggle,
  onExpandOne, onCollapseOne, onExpandAll, onCollapseAll, onReset,
}: {
  data: SankeyData;
  mode: SankeyMode;
  onModeChange: (m: SankeyMode) => void;
  expanded: Set<string>;
  onToggle: (n: SankeyNode, all: SankeyNode[]) => void;
  onExpandOne: () => void;
  onCollapseOne: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onReset: () => void;
}) {
  const isTimeline = mode === "timeline";
  const layout = useMemo(
    () => (isTimeline ? layoutTimelineSankey(data) : layoutSankey(data)),
    [data, isTimeline],
  );
  const rec = data.reconciliation ?? { conservation_error: 0, max_carry_forward_error: 0 };
  const balanced = Math.abs(rec.conservation_error) < 1;
  const carryOk = !data.monthly_reconciliation?.length
    || (rec.max_carry_forward_error ?? 0) < 1;

  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverLink, setHoverLink] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState>(null);
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Expense categories take CHART_SERIES in order; children inherit the parent's colour.
  const expenseColours = useMemo(() => {
    const map = new Map<string, string>();
    let i = 0;
    const byLabel = new Map<string, string>();
    for (const n of layout.nodes) {
      if (n.node_type !== "expense" || n.parent_id) continue;
      const key = n.label;
      if (!byLabel.has(key)) {
        const c = expenseColor(key, i);
        if (!/^(other|others|uncategor)/i.test(key)) i += 1;
        byLabel.set(key, c);
      }
      map.set(n.id, byLabel.get(key)!);
    }
    for (const n of layout.nodes) {
      if (map.has(n.id)) continue;
      let cur: LayoutNode | undefined = n;
      while (cur?.parent_id) {
        cur = layout.nodeMap.get(cur.parent_id);
        if (cur && map.has(cur.id)) { map.set(n.id, map.get(cur.id)!); break; }
      }
    }
    return map;
  }, [layout]);

  const highlightLinks = useMemo(() => {
    if (hoverLink) return new Set([hoverLink]);
    if (hoverNode) return pathLinkIds(hoverNode, layout.links);
    return null;
  }, [hoverLink, hoverNode, layout.links]);

  const highlightNodes = useMemo(() => {
    if (!hoverNode && !hoverLink) return null;
    const s = new Set<string>();
    if (hoverNode) s.add(hoverNode);
    if (hoverLink) {
      const l = layout.links.find(x => x.id === hoverLink);
      if (l) { s.add(l.sourceId); s.add(l.targetId); }
    }
    return s;
  }, [hoverNode, hoverLink, layout.links]);

  const clientToTooltip = (e: React.MouseEvent, el: Element) => {
    const rect = el.getBoundingClientRect();
    return { x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 8 };
  };

  const toggleFullscreen = async () => {
    if (!shellRef.current) return;
    try {
      if (!document.fullscreenElement) await shellRef.current.requestFullscreen();
      else await document.exitFullscreen();
    } catch { /* fullscreen blocked: stay inline */ }
  };

  const subtitle = isTimeline
    ? "Each month: what you started with, what came in, what went out, and what carried over"
    : mode === "period"
      ? "The whole range: opening balance, income, real spend, savings, closing balance"
      : "Month by month, with each category opened up";

  const showLink = (l: LayoutLink, e: React.MouseEvent) => {
    setHoverLink(l.id);
    const s = layout.nodeMap.get(l.sourceId)!;
    const t = layout.nodeMap.get(l.targetId)!;
    const { x, y } = clientToTooltip(e, svgRef.current!);
    setTooltip({ kind: "link", link: l, source: s, target: t, x, y });
  };

  return (
    <div ref={shellRef} className={clsx(fullscreen && "overflow-auto bg-bg p-6")}>
      <Card>
        <CardTitle
          subtitle={subtitle}
          action={
            <span className="hidden flex-wrap items-center gap-2 md:flex">
              <Chip size="sm" tone={balanced ? "success" : "warning"}>
                {balanced ? "Balances match" : `${inr(Math.abs(rec.conservation_error))} unexplained`}
              </Chip>
              {(mode === "monthly" || isTimeline) && !carryOk && (
                <Chip size="sm" tone="warning">
                  {inr(rec.max_carry_forward_error ?? 0)} gap between months
                </Chip>
              )}
            </span>
          }
        >
          {TITLE}
        </CardTitle>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Segmented<SankeyMode>
            ariaLabel="Flow view"
            size="sm"
            options={MODES}
            value={mode}
            onChange={onModeChange}
          />
          <div className="flex flex-wrap items-center gap-2 md:ml-auto">
            {isTimeline ? (
              <>
                <IconButton size="sm" aria-label="Zoom out" onClick={() => setZoom(z => Math.max(0.5, z - 0.15))}>
                  <ZoomOut className="h-4 w-4" strokeWidth={1.75} />
                </IconButton>
                <span className="min-w-[3rem] text-center text-sm font-semibold tabular-nums text-muted">
                  {Math.round(zoom * 100)}%
                </span>
                <IconButton size="sm" aria-label="Zoom in" onClick={() => setZoom(z => Math.min(2, z + 0.15))}>
                  <ZoomIn className="h-4 w-4" strokeWidth={1.75} />
                </IconButton>
                <Button variant="ghost" size="sm" onClick={toggleFullscreen}>
                  {fullscreen
                    ? <><Minimize2 className="h-4 w-4" strokeWidth={1.75} /> Exit full screen</>
                    : <><Maximize2 className="h-4 w-4" strokeWidth={1.75} /> Full screen</>}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setZoom(1); onReset(); }}>
                  <RotateCcw className="h-4 w-4" strokeWidth={1.75} /> Reset
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={onExpandOne}>
                  <Plus className="h-4 w-4" strokeWidth={1.75} /> Open a level
                </Button>
                <Button variant="ghost" size="sm" onClick={onCollapseOne}>
                  <Minus className="h-4 w-4" strokeWidth={1.75} /> Close a level
                </Button>
                <Button variant="ghost" size="sm" onClick={onExpandAll}>Open all</Button>
                <Button variant="ghost" size="sm" onClick={onCollapseAll}>Close all</Button>
                <Button variant="ghost" size="sm" onClick={onReset}>
                  <RotateCcw className="h-4 w-4" strokeWidth={1.75} /> Reset
                </Button>
              </>
            )}
          </div>
        </div>

        <div
          className={clsx(
            "relative mt-4 overflow-x-auto overflow-y-hidden rounded-m",
            fullscreen && "max-h-[calc(100vh-14rem)]",
          )}
        >
          <div style={{ width: Math.max(layout.width * zoom, 360), minWidth: "100%" }}>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              width={layout.width * zoom}
              height={layout.height * zoom}
              className={clsx(!isTimeline && "w-full min-w-[320px] max-h-[320px]")}
              preserveAspectRatio="xMinYMid meet"
              role="img"
              aria-label="Money flow diagram. The totals underneath list the same figures."
              style={{ fontFamily: "var(--font)" }}
              onMouseLeave={() => { setHoverNode(null); setHoverLink(null); setTooltip(null); }}
            >
              {/* Timeline month columns */}
              {isTimeline && (data.periods ?? []).map((p, i) => {
                const colX = TIMELINE_PAD + i * (TIMELINE_COL_W + TIMELINE_COL_GAP);
                return (
                  <g key={p}>
                    <rect
                      x={colX - 6}
                      y={6}
                      width={TIMELINE_COL_W + 12}
                      height={layout.height - 12}
                      rx={10}
                      fill={SANKEY_COLORS.column}
                    />
                    <text
                      x={colX + TIMELINE_COL_W / 2}
                      y={22}
                      textAnchor="middle"
                      fill={SANKEY_COLORS.columnLabel}
                      style={{ fontSize: 11, fontWeight: 800 }}
                    >
                      {monthShort(p)}
                    </text>
                    <text
                      x={colX + TIMELINE_COL_W / 2}
                      y={33}
                      textAnchor="middle"
                      fill={SANKEY_COLORS.columnSub}
                      style={{ fontSize: 8, fontWeight: 500 }}
                    >
                      {p.split("-")[0]}
                    </text>
                  </g>
                );
              })}

              {/* Detailed mode: one block per month */}
              {mode === "monthly" && (data.periods ?? []).map((p, i) => {
                const top = layout.blockTops[i] ?? 0;
                const nextTop = layout.blockTops[i + 1] ?? layout.height;
                const h = (nextTop - top) - 8;
                return (
                  <g key={p}>
                    <rect
                      x={12}
                      y={top}
                      width={layout.width - 24}
                      height={Math.max(h, 64)}
                      rx={10}
                      fill={SANKEY_COLORS.column}
                    />
                    <text x={22} y={top + 15} fill={SANKEY_COLORS.columnLabel} style={{ fontSize: 10, fontWeight: 800 }}>
                      {monthYear(p)}
                    </text>
                  </g>
                );
              })}

              <g className="links">
                {layout.links.map(l => {
                  const { color, dashed } = linkColors(l.linkType, l.sourceType);
                  const tint = expenseColours.get(l.targetId) && l.linkType === "tree"
                    ? expenseColours.get(l.targetId)!
                    : color;
                  const lit = !highlightLinks || highlightLinks.has(l.id);
                  const isLine = l.linkType === "carry" || l.linkType === "tree";

                  if (isLine) {
                    return (
                      <path
                        key={l.id}
                        d={l.path}
                        fill="none"
                        stroke={tint}
                        strokeOpacity={lit ? (dashed ? 0.55 : 0.3) : SANKEY_COLORS.link.faded}
                        strokeWidth={l.width}
                        strokeLinecap="round"
                        strokeDasharray={dashed ? "6 4" : undefined}
                        className="transition-[stroke-opacity] duration-200"
                        onMouseEnter={e => showLink(l, e)}
                        onMouseLeave={() => { setHoverLink(null); setTooltip(null); }}
                      />
                    );
                  }

                  return (
                    <path
                      key={l.id}
                      d={l.path}
                      fill={tint}
                      fillOpacity={lit ? SANKEY_COLORS.link.fillOpacity : SANKEY_COLORS.link.faded / 2}
                      stroke={tint}
                      strokeOpacity={lit ? SANKEY_COLORS.link.strokeOpacity : 0}
                      strokeWidth={0.5}
                      className="transition-[fill-opacity,stroke-opacity] duration-200"
                      onMouseEnter={e => showLink(l, e)}
                      onMouseLeave={() => { setHoverLink(null); setTooltip(null); }}
                    />
                  );
                })}
              </g>

              {layout.nodes.map(n => {
                if (isTimeline && isTimelineHubNode(n.node_type)) return null;
                const theme = nodeTheme(n.node_type, n.layer);
                const strip = expenseColours.get(n.id) ?? theme.color;
                const isExpanded = expanded.has(n.id);
                const lit = !highlightNodes || highlightNodes.has(n.id);

                return (
                  <g
                    key={n.id}
                    opacity={lit ? 1 : 0.3}
                    className={clsx("transition-opacity duration-200", n.expandable && "cursor-pointer")}
                    onClick={() => n.expandable && onToggle(n, data.nodes)}
                    onMouseEnter={e => {
                      setHoverNode(n.id);
                      const { x, y } = clientToTooltip(e, svgRef.current!);
                      setTooltip({ kind: "node", node: n, x, y });
                    }}
                    onMouseLeave={() => {
                      setHoverNode(null);
                      setTooltip(null);
                    }}
                  >
                    <rect
                      x={n.x}
                      y={n.y}
                      width={n.w}
                      height={n.h}
                      rx={6}
                      fill={theme.fill}
                      stroke={isExpanded ? strip : theme.stroke}
                      strokeWidth={isExpanded ? 1 : 0.75}
                    />
                    <rect
                      x={n.x + 2.5}
                      y={n.y + 3.5}
                      width={2.5}
                      height={Math.max(n.h - 7, 2)}
                      rx={1.25}
                      fill={strip}
                      className="pointer-events-none"
                    />
                    {n.expandable && (
                      <text
                        x={n.x + n.w - 6}
                        y={n.y + 9}
                        textAnchor="middle"
                        fill={theme.muted}
                        className="pointer-events-none"
                        style={{ fontSize: 7, fontWeight: 800 }}
                      >
                        {isExpanded ? "−" : "+"}
                      </text>
                    )}
                    <text
                      x={n.x + n.w / 2 + 1}
                      y={n.y + (n.pct != null ? 12 : 14)}
                      textAnchor="middle"
                      fill={theme.amount}
                      className="pointer-events-none"
                      style={{ fontSize: 9, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}
                    >
                      {inr(n.amount)}
                    </text>
                    <text
                      x={n.x + n.w / 2 + 1}
                      y={n.y + (n.pct != null ? 21 : 23)}
                      textAnchor="middle"
                      fill={theme.text}
                      className="pointer-events-none"
                      style={{ fontSize: 7, fontWeight: 500 }}
                    >
                      {truncate(categoryLabel(n.label), labelMaxChars(n.w))}
                    </text>
                    {n.pct != null && (
                      <text
                        x={n.x + n.w / 2 + 1}
                        y={n.y + 27.5}
                        textAnchor="middle"
                        fill={theme.muted}
                        className="pointer-events-none"
                        style={{ fontSize: 6, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}
                      >
                        {n.pct}%
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          {tooltip && <SankeyTooltip tooltip={tooltip} mode={mode} />}
        </div>

      </Card>
    </div>
  );
}


const TOOLTIP_CLASS =
  "pointer-events-none absolute z-20 max-w-[280px] rounded-[16px] bg-card px-3.5 py-3 text-[14px] shadow-float";

function SankeyTooltip({ tooltip, mode }: { tooltip: TooltipState; mode: SankeyMode }) {
  if (!tooltip) return null;

  if (tooltip.kind === "node") {
    const n = tooltip.node;
    return (
      <div className={TOOLTIP_CLASS} style={{ left: tooltip.x, top: tooltip.y }}>
        <div className="font-extrabold tabular-nums text-ink">{inr(n.amount)}</div>
        <div className="mt-0.5 font-medium text-ink-2">{categoryLabel(n.label)}</div>
        {n.pct != null && <div className="mt-1 text-[13px] text-muted">{n.pct}% of the flow</div>}
        {n.period && mode !== "period" && (
          <div className="mt-1 text-[13px] text-muted">{monthYear(n.period)}</div>
        )}
        {n.expandable && <div className="mt-1.5 text-[13px] font-semibold text-accent-700">Click to open it up</div>}
      </div>
    );
  }

  const { link, source, target } = tooltip;
  const isCarry = link.linkType === "carry";

  return (
    <div className={TOOLTIP_CLASS} style={{ left: tooltip.x, top: tooltip.y }}>
      {isCarry ? (
        <>
          <div className="font-medium text-ink-2">Balance carried into the next month</div>
          <div className="mt-1 font-extrabold tabular-nums text-ink">{inr(link.link.value)}</div>
          {link.link.period_from && link.link.period_to && (
            <div className="mt-1 text-[13px] text-muted">
              {monthYear(link.link.period_from)} to {monthYear(link.link.period_to)}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="font-medium text-ink-2">
            {categoryLabel(source.label)} to {categoryLabel(target.label)}
          </div>
          <div className="mt-1 font-extrabold tabular-nums text-ink">{inr(link.link.value)}</div>
        </>
      )}
    </div>
  );
}

function labelMaxChars(cardWidth: number): number {
  return Math.max(8, Math.floor(cardWidth / 6));
}

function truncate(s: string, n: number) {
  if (s.length <= n) return s;
  return `${s.slice(0, Math.max(n - 1, 4))}…`;
}
