"use client";

import { Suspense } from "react";

import { CardSkeleton, Skeleton } from "@/components/ui";
import BlinkitProductContent from "./content";

export default function BlinkitProductPage() {
  return (
    <Suspense fallback={<div className="space-y-6"><Skeleton className="h-8 w-64" /><CardSkeleton height={360} /></div>}>
      <BlinkitProductContent />
    </Suspense>
  );
}
