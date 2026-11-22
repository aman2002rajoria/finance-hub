"use client";

// The bulk-tag work area (queue of counterparties, selected one, "Tag N
// charges as X"), plus the rule editor it opens. Used on Spending's
// "Untagged" view and on the unlinked /categorize page.

import { useState } from "react";

import { GroupTabPanel } from "@/components/categorize/GroupTabPanel";
import { useToast } from "@/components/ledger/primitives";
import { RuleEditorModal, type RuleEditorSeed } from "@/components/ledger/RuleEditorModal";

type Kind = "merchant" | "vpa" | "combined";

export const TAG_KINDS: { value: Kind; label: string; noun: string }[] = [
  { value: "merchant", label: "Counterparty", noun: "counterparty" },
  { value: "vpa", label: "VPA", noun: "VPA" },
  { value: "combined", label: "Both", noun: "counterparty and VPA" },
];

export function BulkTagView() {
  const [kind, setKind] = useState<Kind>("merchant");
  const [ruleSeed, setRuleSeed] = useState<RuleEditorSeed | null>(null);
  const toast = useToast();
  const current = TAG_KINDS.find(k => k.value === kind) ?? TAG_KINDS[0];

  return (
    <>
      <GroupTabPanel
        kind={kind}
        kinds={TAG_KINDS.map(k => ({ value: k.value, label: k.label }))}
        onKindChange={setKind}
        noun={current.noun}
        onMakeRule={(tree, name, category) => setRuleSeed({ tree, name, category })}
        onTagged={msg => toast.show(msg)}
      />
      <RuleEditorModal
        open={!!ruleSeed}
        seed={ruleSeed}
        onClose={() => setRuleSeed(null)}
        onSaved={msg => toast.show(msg)}
      />
      {toast.node}
    </>
  );
}
