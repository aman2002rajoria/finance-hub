"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { Segmented } from "@/components/ui";

const TABS = [
  { value: "/blinkit/analytics", label: "Overview" },
  { value: "/blinkit/orders", label: "Orders" },
  { value: "/blinkit/explorer", label: "Explore" },
] as const;

type TabHref = (typeof TABS)[number]["value"];

/** Section navigation for Groceries: a segmented control under the page header (§7). */
export default function BlinkitNav() {
  const pathname = usePathname();
  const router = useRouter();

  const active: TabHref =
    TABS.find(t => pathname === t.value || pathname.startsWith(t.value + "/"))?.value
    ?? "/blinkit/analytics"; // product and drill-down pages sit under Overview

  useEffect(() => {
    for (const t of TABS) router.prefetch(t.value);
  }, [router]);

  return (
    <nav aria-label="Groceries sections">
      <Segmented<TabHref>
        ariaLabel="Groceries sections"
        options={TABS.map(t => ({ value: t.value, label: t.label }))}
        value={active}
        onChange={(href) => {
          if (href !== pathname) router.push(href);
        }}
      />
    </nav>
  );
}
