"use client";

import { useState } from "react";
import { DecisionHistory } from "@/components/decisions/decision-history";
import { IntelQuality } from "@/components/decisions/intel-quality";
import { ManualAllocation } from "@/components/decisions/manual-allocation";
import { RecommendationInspector } from "@/components/decisions/recommendation-inspector";
import { ReviewQueue } from "@/components/decisions/review-queue";
import { Section } from "@/components/section";

export function DecisionsTab({ names }: { names: ReadonlyMap<string, string> }) {
  const [selected, setSelected] = useState<number>();
  return (
    <>
      <section className="grid gap-8 border-t py-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="min-w-0">
          <h2 className="mb-4 text-sm font-medium">Waiting for review</h2>
          <ReviewQueue names={names} selectedId={selected} onSelect={setSelected} />
        </div>
        <div className="min-w-0 lg:border-l lg:pl-8">
          <h2 className="mb-4 text-sm font-medium">Recommendation</h2>
          <RecommendationInspector id={selected} names={names} />
        </div>
      </section>
      <Section title="Send a shipment yourself">
        <ManualAllocation />
      </Section>
      <Section title="Decision history">
        <DecisionHistory names={names} />
      </Section>
      <Section title="Model evidence">
        <IntelQuality />
      </Section>
    </>
  );
}
