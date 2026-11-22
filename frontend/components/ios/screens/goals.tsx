"use client";

import { CalendarClock, Minus, MoreHorizontal, Plus } from "lucide-react";

import { addMonths, inflate, monthsBetween, monthsToReach, requiredMonthly } from "@/lib/wealth";
import { DATA, GoalPath } from "../charts";
import { dayMonth, monthName, monthYear, rupees, short, type GoalView, type IosData } from "../data";
import { Card, Chip, EmojiTile, Group, InlineNav, LargeTitle, M, NavCircle, Row, Screen, SectionHeader, STATUS_H, type Theme } from "../kit";

export const GOAL_COLOR: Record<string, string> = { "g-laptop": DATA.violet, "g-japan": DATA.orange, "g-house": DATA.pink };
const colorOf = (g: GoalView) => GOAL_COLOR[g.goal.id] ?? DATA.teal;
const toneColor = (t: GoalView["tone"]) => (t === "success" ? "var(--pos)" : t === "danger" ? "var(--neg)" : t === "warning" ? "var(--warn)" : "var(--l1)");

/* ------------------------------------------------------------- Goals */

function GoalCard({ g, asOf }: { g: GoalView; asOf: string }) {
  const s = g.status;
  const hist = g.goal.history ?? [];
  const slipped = g.goal.plannedDate && g.goal.plannedDate !== g.goal.targetDate;
  return (
    <Card style={{ padding: "14px 16px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <EmojiTile emoji={g.emoji} size={40} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{g.goal.name}</div>
          <div className="subhead l2">{short(s.target)} by {monthYear(g.goal.targetDate)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="brand" style={{ fontSize: 22, lineHeight: "26px", color: toneColor(g.tone) }}>{g.oddsText}</div>
          <div className="caption l2" style={{ fontWeight: 500 }}>{g.word}</div>
        </div>
      </div>
      <div style={{ margin: "8px -2px 0" }}>
        <GoalPath
          history={hist} events={g.goal.events ?? []} target={s.target} start={hist[0]?.date ?? asOf} end={g.goal.targetDate}
          asOf={asOf} current={s.current} projected={s.projected} w={342} h={84} color={colorOf(g)} pinSize={20}
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
        <span className="footnote l2"><b style={{ color: "var(--l1)", fontWeight: 600 }}>{short(s.current)}</b> saved · {rupees(s.monthly)}/mo</span>
        {slipped
          ? <Chip tone="warn"><CalendarClock size={13} strokeWidth={2.4} />{monthName(g.goal.plannedDate!)} → {monthName(g.goal.targetDate)}</Chip>
          : g.extra > 0 ? <Chip tone="warn">+{short(g.extra)}/mo → 80%</Chip> : <Chip tone="pos">On track</Chip>}
      </div>
    </Card>
  );
}

export function GoalsScreen({ d, theme }: { d: IosData; theme: Theme }) {
  const likely = d.goals.filter((g) => g.tone === "success").length;
  return (
    <Screen theme={theme} tab="goals">
      <LargeTitle title="Goals" trailing={<NavCircle label="Add a goal"><Plus size={19} strokeWidth={2.4} /></NavCircle>} />
      <div style={{ padding: `0 ${M + 4}px 16px`, display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="brand" style={{ fontSize: 22, lineHeight: "28px" }}><span style={{ color: "var(--pos)" }}>{likely} of {d.goals.length}</span> likely</span>
        <span className="footnote l2">Usual surplus {short(d.w.usual.surplus)}/mo</span>
      </div>
      <div style={{ display: "grid", gap: 12 }}>
        {d.goals.map((g) => <GoalCard key={g.goal.id} g={g} asOf={d.w.asOf} />)}
      </div>
    </Screen>
  );
}

/* -------------------------------------------------------- Goal detail */

export function GoalDetailScreen({ d, theme }: { d: IosData; theme: Theme }) {
  const g = d.goals.find((x) => x.goal.id === "g-laptop") ?? d.goals[0];
  const s = g.status, goal = g.goal;
  const hist = goal.history ?? [];
  const asOf = d.w.asOf;
  const color = colorOf(g);
  // Levers, computed: back to the planned date, or a bit more a month.
  const planned = goal.plannedDate ?? goal.targetDate;
  const mPlanned = Math.max(1, monthsBetween(asOf, planned));
  const needPlanned = Math.ceil(requiredMonthly(inflate(goal.targetToday, goal.inflation, mPlanned), s.current, goal.expectedReturn, mPlanned) / 100) * 100;
  const more = goal.monthly + 2000;
  const mMore = monthsToReach(s.target, s.current, more, goal.expectedReturn);
  const etaMore = mMore != null ? addMonths(asOf, mMore) : null;
  const events = goal.events ?? [];
  return (
    <Screen theme={theme} tab="goals">
      <InlineNav back="Goals" material={false} trailing={<NavCircle label="More"><MoreHorizontal size={19} strokeWidth={2.4} /></NavCircle>} />
      <div style={{ paddingTop: STATUS_H + 44 + 6 }}>
        <div style={{ padding: `0 ${M + 4}px`, display: "flex", alignItems: "center", gap: 14 }}>
          <EmojiTile emoji={g.emoji} size={60} bg="var(--cell)" />
          <div style={{ flex: 1 }}>
            <div className="brand" style={{ fontSize: 28, lineHeight: "33px" }}>{goal.name}</div>
            <div className="subhead l2">{short(s.target)} by {monthYear(goal.targetDate)}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="brand" style={{ fontSize: 28, lineHeight: "33px", color: toneColor(g.tone) }}>{g.oddsText}</div>
            <div className="footnote l2" style={{ fontWeight: 500 }}>{g.word}</div>
          </div>
        </div>
        <div style={{ padding: `14px ${M + 4}px 0`, display: "flex", gap: 8, alignItems: "center" }}>
          {goal.plannedDate && goal.plannedDate !== goal.targetDate && (
            <Chip tone="warn"><CalendarClock size={14} strokeWidth={2.3} />Planned {monthName(goal.plannedDate)} → now {monthName(goal.targetDate)}</Chip>
          )}
          <Chip>{Math.round(s.pct * 100)}% there</Chip>
        </div>

        <Card style={{ marginTop: 16, padding: "14px 14px 10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "0 2px" }}>
            <span style={{ font: "900 18px/22px var(--brand)" }}>Path vs plan</span>
            <span className="footnote l2" style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 12, height: 2.5, borderRadius: 2, background: color }} />Path</span>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 12, height: 0, borderTop: "2px dashed var(--l2)" }} />Plan</span>
            </span>
          </div>
          <div style={{ marginTop: 6 }}>
            <GoalPath
              history={hist} events={events} target={s.target} start={hist[0]?.date ?? asOf} end={goal.targetDate} plannedEnd={goal.plannedDate}
              asOf={asOf} current={s.current} projected={s.projected} w={342} h={176} color={color} pinSize={24} showPlan labels
            />
          </div>
        </Card>

        <div style={{ height: 20 }} />
        <SectionHeader>What happened</SectionHeader>
        <Group>
          {events.map((e, i) => (
            <Row key={e.date} icon={<EmojiTile emoji={e.emoji} size={30} />} title={e.label} sub={dayMonth(e.date)} inset={58} minH={52}
              value={`${e.amount >= 0 ? "+" : "−"}${rupees(e.amount)}`} valueColor={e.amount >= 0 ? "var(--pos)" : e.kind === "pause" ? "var(--l2)" : "var(--neg)"} last={i === events.length - 1} />
          ))}
        </Group>

        <div style={{ height: 20 }} />
        <SectionHeader>Levers</SectionHeader>
        <Group>
          <div style={{ display: "flex", alignItems: "center", minHeight: 52, padding: `0 ${M}px`, position: "relative" }}>
            <span style={{ flex: 1 }}>Each month</span>
            <span style={{ fontWeight: 600, marginRight: 12 }}>{rupees(goal.monthly)}</span>
            <span style={{ display: "flex", background: "var(--fill)", borderRadius: 9, height: 32, alignItems: "center" }}>
              <span style={{ width: 46, display: "grid", placeItems: "center" }}><Minus size={17} strokeWidth={2.4} /></span>
              <span style={{ width: 0.5, height: 18, background: "var(--sep)" }} />
              <span style={{ width: 46, display: "grid", placeItems: "center" }}><Plus size={17} strokeWidth={2.4} /></span>
            </span>
            <span aria-hidden style={{ position: "absolute", left: M, right: 0, bottom: 0, height: 0.5, background: "var(--sep)" }} />
          </div>
          <Row title={`Back to ${monthName(planned)}`} value={<span className="l2">{rupees(needPlanned)}/mo</span>} chevron inset={M} />
          {etaMore && <Row title={`${short(more)}/mo`} value={<span className="l2">Ready {monthYear(etaMore)}</span>} chevron last />}
        </Group>
      </div>
    </Screen>
  );
}
