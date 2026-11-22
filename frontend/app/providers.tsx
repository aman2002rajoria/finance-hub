"use client";

import { DateRangeProvider } from "@/components/analytics/DateRangeProvider";

export function Providers({ children }: { children: React.ReactNode }) {
  return <DateRangeProvider>{children}</DateRangeProvider>;
}
