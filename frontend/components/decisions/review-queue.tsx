"use client";

import { ArrowRight } from "@phosphor-icons/react";
import { ICON_SM } from "@/components/icon-props";
import { QueryBlock } from "@/components/query-block";
import { EmptyState } from "@/components/section";
import { useRecommendations } from "@/lib/api/hooks";
import { formatNumber, formatProbability, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";

// Recommendations waiting for a human (brief section 24), newest first.
export function ReviewQueue({ names, selectedId, onSelect }: { names: ReadonlyMap<string, string>; selectedId?: number; onSelect: (id: number) => void }) {
  const queue = useRecommendations({ status: "PROPOSED", limit: 50 });
  return (
    <QueryBlock query={queue} rows={4}>
      {(data) =>
        data.recommendations.length === 0 ? (
          <EmptyState>Nothing waiting for review</EmptyState>
        ) : (
          <ul className="divide-y" aria-label="Recommendations waiting for review">
            {data.recommendations.map((rec) => {
              const selected = rec.id === selectedId;
              const reasons = (rec.explanation.review_reasons?.length ?? 0) + (rec.explanation.rule_reasons?.length ?? 0);
              return (
                <li key={rec.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(rec.id)}
                    aria-current={selected ? "true" : undefined}
                    className={cn(
                      "w-full px-2 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none",
                      selected && "bg-muted",
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium">
                        {names.get(rec.station_id) ?? rec.station_id}, {humanize(rec.fuel_type).toLowerCase()}
                      </span>
                      <span className="font-mono text-sm tabular-nums">{formatNumber(rec.quantity)} L</span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span>
                        from {names.get(rec.depot_id) ?? rec.depot_id} · tick {rec.tick}
                        {reasons > 0 ? ` · ${reasons} review reason${reasons === 1 ? "" : "s"}` : ""}
                      </span>
                      <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                        {formatProbability(rec.risk_before)}
                        <ArrowRight {...ICON_SM} size={12} aria-label="to" role="img" />
                        {formatProbability(rec.risk_after)}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )
      }
    </QueryBlock>
  );
}
