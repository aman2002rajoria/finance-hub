import type { SankeyData, SankeyLink, SankeyNode } from "@/lib/types";

import {
  CARRY_STROKE,
  type LayoutLink,
  type LayoutNode,
  type LayoutResult,
  ribbonHalfWidth,
} from "./sankeyLayout";

export const TIMELINE_COL_W = 132;
export const TIMELINE_COL_GAP = 24;
export const TIMELINE_NODE_W = 112;
export const TIMELINE_NODE_H = 28;
export const TIMELINE_ROW_GAP = 10;
export const TIMELINE_PAD = 16;
export const TIMELINE_HEADER = 28;

/** Visible spine rows — opening through closing. */
const VISIBLE_ROWS = ["opening", "income", "expense", "savings", "closing"] as const;

function rowIndex(nodeType?: string): number {
  switch (nodeType) {
    case "opening": return 0;
    case "income":
    case "refund": return 1;
    case "available": return 1.35;
    case "expense": return 2;
    case "savings":
    case "drawdown": return 3;
    case "bridge": return 3.35;
    case "closing": return 4;
    default: return 2;
  }
}

export function isTimelineHubNode(nodeType?: string): boolean {
  return nodeType === "available" || nodeType === "refund" || nodeType === "bridge";
}

function flowRibbon(
  sx: number, sy: number, tx: number, ty: number,
  sh: number, th: number, halfW: number,
): string {
  const y1 = sy + sh / 2;
  const y2 = ty + th / 2;
  const mx = (sx + tx) / 2;
  const hw = halfW;
  return [
    `M ${sx} ${y1 - hw}`,
    `C ${mx} ${y1 - hw}, ${mx} ${y2 - hw}, ${tx} ${y2 - hw}`,
    `L ${tx} ${y2 + hw}`,
    `C ${mx} ${y2 + hw}, ${mx} ${y1 + hw}, ${sx} ${y1 + hw}`,
    "Z",
  ].join(" ");
}

function verticalRibbon(
  sx: number, sy: number, sh: number,
  tx: number, ty: number, th: number,
  halfW: number,
): string {
  const x1 = sx;
  const x2 = tx;
  const y1 = sy + sh;
  const y2 = ty;
  const my = (y1 + y2) / 2;
  const hw = halfW;
  return [
    `M ${x1 - hw} ${y1}`,
    `C ${x1 - hw} ${my}, ${x2 - hw} ${my}, ${x2 - hw} ${y2}`,
    `L ${x2 + hw} ${y2}`,
    `C ${x2 + hw} ${my}, ${x1 + hw} ${my}, ${x1 + hw} ${y1}`,
    "Z",
  ].join(" ");
}

function carryHorizontal(s: LayoutNode, t: LayoutNode): string {
  const x1 = s.x + s.w;
  const y1 = s.y + s.h / 2;
  const x2 = t.x;
  const y2 = t.y + t.h / 2;
  const my = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${mx(y1, y2)} ${y1}, ${mx(y1, y2)} ${y2}, ${x2} ${y2}`;
}

function mx(y1: number, y2: number) {
  return (y1 + y2) / 2;
}

function monthShort(period: string): string {
  const [y, m] = period.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(undefined, { month: "short" });
}

export function layoutTimelineSankey(data: SankeyData): LayoutResult {
  const periods = data.periods.length ? data.periods : [""];
  const nodeMap = new Map<string, LayoutNode>();
  const allNodes: LayoutNode[] = [];
  const blockTops: number[] = [];

  const rowStep = TIMELINE_NODE_H + TIMELINE_ROW_GAP;
  const contentTop = TIMELINE_PAD + TIMELINE_HEADER;
  const spineRows = VISIBLE_ROWS.length;

  periods.forEach((period, colIdx) => {
    const colX = TIMELINE_PAD + colIdx * (TIMELINE_COL_W + TIMELINE_COL_GAP);
    blockTops.push(contentTop);

    const blockNodes = data.nodes.filter(n => (n.period ?? "") === period);
    for (const n of blockNodes) {
      const ri = rowIndex(n.node_type);
      const y = contentTop + ri * rowStep;
      const hub = isTimelineHubNode(n.node_type);
      const ln: LayoutNode = {
        ...n,
        x: colX + (TIMELINE_COL_W - (hub ? TIMELINE_NODE_W * 0.6 : TIMELINE_NODE_W)) / 2,
        y,
        w: hub ? TIMELINE_NODE_W * 0.55 : TIMELINE_NODE_W,
        h: hub ? TIMELINE_NODE_H * 0.55 : TIMELINE_NODE_H,
        blockIndex: colIdx,
      };
      allNodes.push(ln);
      nodeMap.set(n.id, ln);
    }
  });

  const maxLinkVal = Math.max(...data.links.map(l => l.value), 1);
  const links: LayoutLink[] = [];

  data.links.forEach((link: SankeyLink, idx) => {
    const s = nodeMap.get(link.source);
    const t = nodeMap.get(link.target);
    if (!s || !t) return;

    const linkType = link.link_type ?? "flow";
    let path: string;
    let width: number;

    if (linkType === "carry") {
      path = carryHorizontal(s, t);
      width = CARRY_STROKE;
    } else {
      const hw = ribbonHalfWidth(link.value, maxLinkVal);
      width = hw;
      const sameCol = s.blockIndex === t.blockIndex;
      if (sameCol || Math.abs(s.x - t.x) < 16) {
        path = verticalRibbon(
          s.x + s.w / 2, s.y, s.h,
          t.x + t.w / 2, t.y, t.h,
          hw,
        );
      } else if (s.x < t.x) {
        path = flowRibbon(s.x + s.w, s.y, t.x, t.y, s.h, t.h, hw);
      } else {
        path = flowRibbon(s.x, s.y, t.x + t.w, t.y, s.h, t.h, hw);
      }
    }

    links.push({
      id: `tl-${idx}`,
      path,
      link,
      linkType,
      sourceType: s.node_type,
      width,
      sourceId: s.id,
      targetId: t.id,
    });
  });

  const width = Math.max(
    TIMELINE_PAD * 2 + periods.length * TIMELINE_COL_W + Math.max(0, periods.length - 1) * TIMELINE_COL_GAP,
    360,
  );
  const height = Math.max(contentTop + spineRows * rowStep + TIMELINE_PAD, 220);

  return { nodes: allNodes, links, width, height, blockTops, nodeMap };
}

export { monthShort };
