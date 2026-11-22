import type { Metadata } from "next";

import GoalsPage from "@/components/goals/GoalsPage";

export const metadata: Metadata = { title: "Goals · Finance Hub" };

export default function Page() {
  return <GoalsPage />;
}
