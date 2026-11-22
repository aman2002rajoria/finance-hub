import type { Metadata } from "next";

import { MotionLab } from "@/components/lab/MotionLab";

export const metadata: Metadata = {
  title: "Motion lab · Finance Hub",
  robots: { index: false },
};

export default function MotionLabPage() {
  return <MotionLab />;
}
