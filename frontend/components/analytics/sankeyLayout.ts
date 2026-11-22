import type { SankeyData, SankeyLink, SankeyNode } from "@/lib/types";

export const VIEW_W = 640;
export const SPINE_W = 140;
export const SIDE_W = 100;
export const CARD_H = 32;
export const SPINE_GAP = 10;
export const SIDE_GAP = 4;
export const INDENT = 10;
export const BLOCK_PAD_TOP = 22;
export const BLOCK_PAD_BOTTOM = 12;
export const BLOCK_GAP = 18;
export const MAX_RIBBON = 10;
export const CARRY_STROKE = 1.5;

export interface LayoutNode extends SankeyNode {
  x: number;
  y: number;
  w: number;
  h: number;
  blockIndex: number;
  pct?: number;
}

export interface LayoutLink {
  id: string;
  path: string;
  link: SankeyLink;
  linkType: string;
  sourceType?: string;
  /** stroke width for carry/tree; ribbon half-width for flow */
  width: number;
  sourceId: string;
  targetId: string;
}

export interface LayoutResult {
  nodes: LayoutNode[];
  links: LayoutLink[];
  width: number;
  height: number;
  blockTops: number[];
  nodeMap: Map<string, LayoutNode>;
}

function spineX(): number {
  return (VIEW_W - SPINE_W) / 2;
}

function leftX(): number {
  return spineX() - SIDE_W - 28;
}

function rightX(): number {
  return spineX() + SPINE_W + 28;
}

function periodKey(n: SankeyNode): string {
  return n.period ?? "";
}

function isSpineCore(n: SankeyNode): boolean {
  return ["opening", "available", "savings", "closing", "drawdown", "bridge"].includes(
    n.node_type ?? "",
  );
}

function isIncomeSide(n: SankeyNode): boolean {
  return ["income", "refund"].includes(n.node_type ?? "");
}

function layoutBlock(
  nodes: SankeyNode[],
  blockTop: number,
  blockIndex: number,
  totals: { cashIn: number; cashOut: number },
): { laid: LayoutNode[]; blockHeight: number; pos: Map<string, LayoutNode> } {
  const laid: LayoutNode[] = [];
  const pos = new Map<string, LayoutNode>();

  const opening = nodes.find(n => n.node_type === "opening");
  const available = nodes.find(n => n.node_type === "available");
  const savings = nodes.find(n => n.node_type === "savings" || n.node_type === "drawdown");
  const closing = nodes.find(n => n.node_type === "closing");
  const bridge = nodes.find(n => n.node_type === "bridge");
  const incomeNodes = nodes.filter(isIncomeSide);
  const expenses = nodes.filter(n => n.node_type === "expense");

  let y = blockTop + BLOCK_PAD_TOP;
  const sx = spineX();

  const place = (n: SankeyNode, x: number, yy: number, w: number, pct?: number) => {
    const ln: LayoutNode = { ...n, x, y: yy, w, h: CARD_H, blockIndex, pct };
    laid.push(ln);
    pos.set(n.id, ln);
    return ln;
  };

  // 1. Opening (spine top)
  if (opening) {
    place(opening, sx, y, SPINE_W, pct(opening.amount, totals.cashIn + opening.amount));
    y += CARD_H + SPINE_GAP;
  }

  // 2. Income sources (left column)
  const incomeY = y;
  let iy = incomeY;
  for (const n of incomeNodes) {
    place(n, leftX(), iy, SIDE_W, pct(n.amount, totals.cashIn));
    iy += CARD_H + SIDE_GAP;
  }
  const incomeBottom = incomeNodes.length ? iy - SIDE_GAP : incomeY;

  // 3. Available (spine)
  if (available) {
    const availY = incomeNodes.length
      ? Math.max(y, incomeBottom - CARD_H)
      : y;
    place(available, sx, availY, SPINE_W);
    y = availY + CARD_H + SPINE_GAP;
  }

  // 4. Expenses (right column) + subtree
  const expRoots = expenses.filter(n => !n.parent_id).sort((a, b) => b.amount - a.amount);
  const childrenOf = new Map<string, SankeyNode[]>();
  for (const n of expenses) {
    if (!n.parent_id) continue;
    const list = childrenOf.get(n.parent_id) ?? [];
    list.push(n);
    childrenOf.set(n.parent_id, list);
  }

  let ey = y - CARD_H - SPINE_GAP + (available ? 0 : CARD_H + SPINE_GAP);
  if (available) ey = pos.get(available.id)!.y;

  for (const n of expRoots) {
    place(n, rightX(), ey, SIDE_W, pct(n.amount, totals.cashOut));
    ey = layoutExpenseTree(n, ey + CARD_H + SIDE_GAP, childrenOf, pos, laid, blockIndex, totals.cashOut);
  }
  const expenseBottom = expRoots.length ? ey : y;

  // 5. Savings (spine) — below expenses
  y = Math.max(y, expenseBottom) + (expRoots.length ? SPINE_GAP : 0);
  if (savings) {
    place(savings, sx, y, SPINE_W, pct(savings.amount, Math.abs(savings.amount) || 1));
    y += CARD_H + SPINE_GAP;
  }
  if (bridge) {
    place(bridge, sx, y, SPINE_W);
    y += CARD_H + SPINE_GAP;
  }

  // 6. Closing (spine bottom)
  if (closing) {
    place(closing, sx, y, SPINE_W);
    y += CARD_H;
  }

  const blockHeight = y - blockTop + BLOCK_PAD_BOTTOM;
  return { laid, blockHeight, pos };
}

function layoutExpenseTree(
  parent: SankeyNode,
  startY: number,
  childrenOf: Map<string, SankeyNode[]>,
  pos: Map<string, LayoutNode>,
  laid: LayoutNode[],
  blockIndex: number,
  cashOut: number,
): number {
  const items = (childrenOf.get(parent.id) ?? []).sort((a, b) => b.amount - a.amount);
  let y = startY;
  const rx = rightX();

  for (const n of items) {
    const d = n.depth ?? 1;
    const ln: LayoutNode = {
      ...n,
      x: rx + d * INDENT,
      y,
      w: Math.max(SIDE_W - d * INDENT, 64),
      h: CARD_H,
      blockIndex,
      pct: pct(n.amount, cashOut),
    };
    laid.push(ln);
    pos.set(n.id, ln);
    y += CARD_H + SIDE_GAP;
    y = layoutExpenseTree(n, y, childrenOf, pos, laid, blockIndex, cashOut);
  }
  return y;
}

function pct(amount: number, total: number): number | undefined {
  if (total <= 0) return undefined;
  return Math.round((amount / total) * 1000) / 10;
}

export function ribbonHalfWidth(value: number, maxVal: number): number {
  if (maxVal <= 0) return 4;
  return Math.max(3, Math.min(MAX_RIBBON, (value / maxVal) * MAX_RIBBON));
}

function flowRibbon(
  sx: number, sy: number, tx: number, ty: number,
  sh: number, th: number, halfW: number,
): string {
  const y1 = sy + sh / 2;
  const y2 = ty + th / 2;
  const x1 = sx;
  const x2 = tx;
  const mx = (x1 + x2) / 2;
  const hw = halfW;
  return [
    `M ${x1} ${y1 - hw}`,
    `C ${mx} ${y1 - hw}, ${mx} ${y2 - hw}, ${x2} ${y2 - hw}`,
    `L ${x2} ${y2 + hw}`,
    `C ${mx} ${y2 + hw}, ${mx} ${y1 + hw}, ${x1} ${y1 + hw}`,
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

function carryCurve(s: LayoutNode, t: LayoutNode): string {
  const x1 = s.x + s.w / 2;
  const y1 = s.y + s.h;
  const x2 = t.x + t.w / 2;
  const y2 = t.y;
  const my = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
}

function treeCurve(s: LayoutNode, t: LayoutNode): string {
  const x1 = s.x + s.w / 2;
  const y1 = s.y + s.h;
  const x2 = t.x + t.w / 2;
  const y2 = t.y;
  const my = y1 + (y2 - y1) * 0.45;
  return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
}

export function layoutSankey(data: SankeyData): LayoutResult {
  const isMonthly = data.mode === "monthly" && data.periods.length > 0;
  const periods = isMonthly ? data.periods : [""];
  const rec = data.reconciliation;

  const allNodes: LayoutNode[] = [];
  const nodeMap = new Map<string, LayoutNode>();
  const blockTops: number[] = [];
  let y = 8;

  const totals = {
    cashIn: rec.cash_in ?? rec.true_income ?? 1,
    cashOut: rec.cash_out ?? rec.net_personal_spend ?? 1,
  };

  for (let i = 0; i < periods.length; i++) {
    const pk = periods[i];
    blockTops.push(y);
    const blockNodes = data.nodes.filter(n => periodKey(n) === pk);

    if (isMonthly && data.monthly_reconciliation) {
      const mr = data.monthly_reconciliation.find(r => r.period === pk);
      if (mr) {
        totals.cashIn = mr.cash_in || 1;
        totals.cashOut = mr.cash_out || 1;
      }
    }

    const { laid, blockHeight, pos } = layoutBlock(blockNodes, y, i, totals);
    for (const n of laid) {
      allNodes.push(n);
      nodeMap.set(n.id, n);
    }
    y += blockHeight + (isMonthly ? BLOCK_GAP : 0);
  }

  const maxLinkVal = Math.max(...data.links.map(l => l.value), 1);
  const links: LayoutLink[] = [];

  data.links.forEach((link, idx) => {
    const s = nodeMap.get(link.source);
    const t = nodeMap.get(link.target);
    if (!s || !t) return;

    const linkType = link.link_type ?? "flow";
    const sourceType = s.node_type;
    let path: string;
    let width: number;

    if (linkType === "carry") {
      path = carryCurve(s, t);
      width = CARRY_STROKE;
    } else if (linkType === "tree" || t.parent_id === s.id) {
      path = treeCurve(s, t);
      width = 2;
    } else {
      const hw = ribbonHalfWidth(link.value, maxLinkVal);
      width = hw;
      const sameColumn = Math.abs(s.x - t.x) < 8;
      if (sameColumn || t.y > s.y + s.h) {
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
      id: `link-${idx}`,
      path,
      link,
      linkType,
      sourceType,
      width,
      sourceId: s.id,
      targetId: t.id,
    });
  });

  return {
    nodes: allNodes,
    links,
    width: VIEW_W,
    height: Math.max(y + 16, 220),
    blockTops,
    nodeMap,
  };
}

export function descendantsOf(nodes: SankeyNode[], rootId: string): string[] {
  const out: string[] = [];
  const walk = (pid: string) => {
    for (const n of nodes) {
      if (n.parent_id === pid) {
        out.push(n.id);
        walk(n.id);
      }
    }
  };
  walk(rootId);
  return out;
}

export function expandOneLevel(nodes: SankeyNode[], expanded: Set<string>): Set<string> {
  const next = new Set(expanded);
  const maxDepth = nodes
    .filter(n => expanded.has(n.id))
    .reduce((m, n) => Math.max(m, n.depth ?? 0), -1);
  const targetDepth = maxDepth + 1;
  for (const n of nodes) {
    if (!n.expandable || expanded.has(n.id)) continue;
    const d = n.depth ?? 0;
    if (d !== targetDepth) continue;
    if (d === 0 || (n.parent_id && expanded.has(n.parent_id))) next.add(n.id);
  }
  return next;
}

export function collapseOneLevel(nodes: SankeyNode[], expanded: Set<string>): Set<string> {
  if (expanded.size === 0) return expanded;
  const maxDepth = Math.max(
    ...nodes.filter(n => expanded.has(n.id)).map(n => n.depth ?? 0),
  );
  const next = new Set(expanded);
  for (const id of expanded) {
    const n = nodes.find(x => x.id === id);
    if (n && (n.depth ?? 0) === maxDepth) next.delete(id);
  }
  return next;
}

export function expandAll(nodes: SankeyNode[]): Set<string> {
  return new Set(nodes.filter(n => n.expandable).map(n => n.id));
}

export function relatedLinkIds(
  nodeId: string,
  links: LayoutLink[],
): Set<string> {
  const out = new Set<string>();
  for (const l of links) {
    if (l.sourceId === nodeId || l.targetId === nodeId) out.add(l.id);
  }
  return out;
}

export function pathLinkIds(nodeId: string, links: LayoutLink[]): Set<string> {
  const out = new Set<string>();
  const stack = [nodeId];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const l of links) {
      if (l.targetId === cur) {
        out.add(l.id);
        stack.push(l.sourceId);
      }
      if (l.sourceId === cur) {
        out.add(l.id);
        stack.push(l.targetId);
      }
    }
  }
  return out;
}
