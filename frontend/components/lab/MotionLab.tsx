"use client";

/*
 * /lab/motion: side-by-side animation options so the owner can pick
 * favourites ("3B, 5A…"). Not linked from the nav. Every option follows
 * design.md §14 curves and falls back to opacity under reduced motion.
 */

import { PageHeader } from "@/components/ui";

import { BarsDemo, DonutDemo } from "./ChartDemos";
import { ButtonsDemo, TabsDemo } from "./ControlDemos";
import { CardEntrance } from "./EntranceDemos";
import { LoadingDemo, PageChangeDemo, SuccessDemo } from "./FlowDemos";
import { LabSection } from "./kit";
import { KpiDemo, NumberChangeDemo } from "./NumberDemos";

export function MotionLab() {
  return (
    <div className="space-y-12 pb-24">
      <PageHeader
        eyebrow="Lab"
        title="Motion lab"
        description="Each section shows the same moment animated a few ways. Watch them side by side, press Replay as often as you like, and note the ones you prefer, for example 3B and 5A."
      />

      <LabSection
        n={1}
        title="Card entrance on page load"
        intro="How the dashboard cards arrive the first time you open a page."
        options={[
          { name: "Fade and rise", note: "16px rise, .6s soft ease, 60ms stagger. The current spec.", render: () => <CardEntrance kind="rise" /> },
          { name: "Rise with a slight scale", note: "Same rise, plus scale .98 to 1 on the spring.", render: () => <CardEntrance kind="riseScale" /> },
          { name: "Bento pop", note: "Each card pops from scale .92 on the spring, 60ms apart.", render: () => <CardEntrance kind="pop" /> },
          { name: "Blur in", note: "Blur 8px to sharp while fading in.", render: () => <CardEntrance kind="blur" /> },
        ]}
      />

      <LabSection
        n={2}
        title="KPI numbers"
        intro="The headline figures on first load. The green number is the one that matters most."
        options={[
          { name: "Count up", note: "Counts from zero over .8s.", render: () => <KpiDemo kind="count" /> },
          { name: "Odometer", note: "Each digit rolls into place, left to right.", render: () => <KpiDemo kind="odometer" /> },
          { name: "Fade in", note: "The final number fades in. No counting.", render: () => <KpiDemo kind="fade" /> },
          { name: "Count up, then one pulse", note: "Counts up, then the accent number pulses once.", render: () => <KpiDemo kind="countPulse" /> },
        ]}
      />

      <LabSection
        n={3}
        title="Bar chart growth"
        intro="Monthly spend, May to October, with the current month in accent."
        options={[
          { name: "All together", note: "Every bar grows from 0 at once, 1s spring.", render: () => <BarsDemo kind="together" /> },
          { name: "Left to right", note: "Bars grow one after another, 70ms apart.", render: () => <BarsDemo kind="stagger" /> },
          { name: "Focus bar last", note: "Past months fade in, then October grows on the spring.", render: () => <BarsDemo kind="focus" /> },
          { name: "Grow with labels", note: "Bars grow while the values above them count up.", render: () => <BarsDemo kind="labels" /> },
        ]}
      />

      <LabSection
        n={4}
        title="Donut"
        intro="October spend by category."
        options={[
          { name: "Sweep", note: "Drawn clockwise from the top over 1s.", render: () => <DonutDemo kind="sweep" id="a" /> },
          { name: "Segments pop", note: "Each category pops in on the spring, one by one.", render: () => <DonutDemo kind="pop" id="b" /> },
          { name: "Fade and scale", note: "The whole donut fades in from scale .9.", render: () => <DonutDemo kind="fade" id="c" /> },
        ]}
      />

      <LabSection
        n={5}
        title="Tabs and segmented controls"
        intro="Switching between categories. Click the tabs, or press Next tab to move every option together."
        remount={false}
        replayLabel="Next tab"
        options={[
          { name: "Sliding pill", note: "The active pill slides on the spring. Content swaps instantly.", render: run => <TabsDemo kind="slide" id="a" run={run} /> },
          { name: "Crossfade", note: "The pill jumps; the list below crossfades in .2s.", render: run => <TabsDemo kind="crossfade" id="b" run={run} /> },
          { name: "Slide in the direction of travel", note: "The pill slides and the list slides the same way.", render: run => <TabsDemo kind="directional" id="c" run={run} /> },
        ]}
      />

      <LabSection
        n={6}
        title="Buttons"
        intro="The 3D lip button. Hover, then press and hold to feel each one."
        options={[
          { name: "Lip press", note: "Up 2px on hover, down 4px on press. The current spec.", render: () => <ButtonsDemo kind="lip" /> },
          { name: "Lip press and ripple", note: "Adds a quiet ripple from where you click.", render: () => <ButtonsDemo kind="ripple" /> },
          { name: "Lip press and glow", note: "Adds a soft accent glow, only while pressed.", render: () => <ButtonsDemo kind="glow" /> },
        ]}
      />

      <LabSection
        n={7}
        title="Page change"
        intro="Moving between pages, shown inside a small frame. Click a tab in the frame, or press Switch page."
        remount={false}
        replayLabel="Switch page"
        options={[
          { name: "None", note: "The new page simply appears.", render: run => <PageChangeDemo kind="none" run={run} /> },
          { name: "Crossfade", note: "Old page fades out as the new one fades in, .2s.", render: run => <PageChangeDemo kind="fade" run={run} /> },
          { name: "Square ripple", note: "Accent squares ripple out from the click, cover, then clear from the centre.", render: run => <PageChangeDemo kind="squares" run={run} /> },
        ]}
      />

      <LabSection
        n={8}
        title="Loading to content"
        intro="Recent transactions arriving after a short wait."
        options={[
          { name: "Skeleton, then crossfade", note: "Shimmering placeholders fade into the rows.", render: () => <LoadingDemo kind="shimmerFade" /> },
          { name: "Skeleton, then rise", note: "Placeholders leave; rows fade and rise, staggered.", render: () => <LoadingDemo kind="shimmerRise" /> },
          { name: "AI working", note: "Three dots and a status line that changes, then the rows.", render: () => <LoadingDemo kind="ai" /> },
        ]}
      />

      <LabSection
        n={9}
        title="Success moment"
        intro="After a statement finishes importing. One small moment, nothing more."
        options={[
          { name: "Check draws in", note: "A check mark draws itself inside a soft circle.", render: () => <SuccessDemo kind="check" /> },
          { name: "Illustration pops", note: "The illustration pops from scale .9 on the spring.", render: () => <SuccessDemo kind="pop" /> },
          { name: "Toast", note: "A toast rises 12px from the bottom, then leaves after 4s.", render: () => <SuccessDemo kind="toast" /> },
        ]}
      />

      <LabSection
        n={10}
        title="Number change on filter switch"
        intro="The total when you switch between 1M, 3M and 6M. Use the filter, or press Next range."
        remount={false}
        replayLabel="Next range"
        options={[
          { name: "Instant", note: "The new number replaces the old one.", render: run => <NumberChangeDemo kind="instant" run={run} /> },
          { name: "Count between", note: "Counts from the old value to the new one, .6s.", render: run => <NumberChangeDemo kind="count" run={run} /> },
          { name: "Slide up", note: "The old value slides up and out as the new one slides in.", render: run => <NumberChangeDemo kind="slide" run={run} /> },
        ]}
      />
    </div>
  );
}
