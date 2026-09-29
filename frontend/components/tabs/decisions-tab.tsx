"use client";

import { useMemo, useRef, useState } from "react";
import { DecisionHistory } from "@/components/decisions/decision-history";
import { IntelQuality } from "@/components/decisions/intel-quality";
import { ManualAllocation } from "@/components/decisions/manual-allocation";
import { RecommendationInspector } from "@/components/decisions/recommendation-inspector";
import { ReviewQueue } from "@/components/decisions/review-queue";
import { QueryBlock } from "@/components/query-block";
import { Section } from "@/components/section";
import { useRecommendations } from "@/lib/api/hooks";
import type { Recommendation } from "@/lib/api/schemas";
import { seriesKey, sortQueue } from "@/lib/queue";

interface Selection {
  key: string; // station:fuel, stable across ticks
  id: number; // the proposal last shown for it
}

export function DecisionsTab({ names }: { names: ReadonlyMap<string, string> }) {
  const queue = useRecommendations({ status: "PROPOSED", limit: 100 });
  const items = useMemo(() => sortQueue(queue.data?.recommendations ?? [], names), [queue.data, names]);
  const [selection, setSelection] = useState<Selection>();
  const detailsRef = useRef<HTMLHeadingElement>(null);

  // Nothing picked yet: show the most urgent. Picked: follow the newest proposal for that pair.
  const key = selection?.key ?? (items[0] ? seriesKey(items[0]) : undefined);
  const live = items.find((r) => seriesKey(r) === key);
  if (selection && live && live.id !== selection.id) setSelection({ key: selection.key, id: live.id });
  const shownId = live?.id ?? selection?.id;

  const select = (rec: Recommendation) => {
    setSelection({ key: seriesKey(rec), id: rec.id });
    // One column on small screens: the details sit below the list, so bring them into view.
    if (window.matchMedia("(max-width: 1023px)").matches) detailsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
      <section className="grid gap-8 border-t py-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="min-w-0">
          <h2 className="mb-4 text-sm font-medium">
            Waiting for review {items.length > 0 ? <span className="font-normal text-muted-foreground">({items.length})</span> : null}
          </h2>
          <QueryBlock query={queue} rows={4}>
            {() => <ReviewQueue items={items} names={names} selectedKey={key} onSelect={select} />}
          </QueryBlock>
        </div>
        <div className="min-w-0 lg:border-l lg:pl-8">
          <h2 ref={detailsRef} className="mb-4 scroll-mt-4 text-sm font-medium">
            Recommendation
          </h2>
          <RecommendationInspector
            live={live}
            id={shownId}
            formKey={key}
            names={names}
            onDecided={(id) => key && setSelection({ key, id })}
          />
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
