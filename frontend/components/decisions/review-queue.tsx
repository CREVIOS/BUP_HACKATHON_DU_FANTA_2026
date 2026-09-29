"use client";

import { ArrowRight } from "@phosphor-icons/react";
import { ICON_SM } from "@/components/icon-props";
import { EmptyState } from "@/components/section";
import type { Recommendation } from "@/lib/api/schemas";
import { formatNumber, formatProbability, humanize } from "@/lib/format";
import { seriesKey } from "@/lib/queue";
import { cn } from "@/lib/utils";

// Recommendations waiting for a human (brief section 24). Rows are keyed by station and fuel, so a
// newer proposal for the same pair updates the row in place instead of replacing it.
export function ReviewQueue({
  items,
  names,
  selectedKey,
  onSelect,
}: {
  items: Recommendation[];
  names: ReadonlyMap<string, string>;
  selectedKey?: string;
  onSelect: (rec: Recommendation) => void;
}) {
  if (items.length === 0) return <EmptyState>Nothing waiting for review</EmptyState>;
  return (
    <ul className="divide-y" aria-label="Recommendations waiting for review">
      {items.map((rec) => {
        const key = seriesKey(rec);
        const selected = key === selectedKey;
        const reasons = new Set([...(rec.explanation.review_reasons ?? []), ...(rec.explanation.rule_reasons ?? [])]).size;
        const helps = (rec.risk_after ?? 1) < (rec.risk_before ?? 0);
        const saved = (rec.explanation.shortfall_before ?? 0) - (rec.explanation.shortfall_after ?? 0);
        return (
          <li key={key}>
            <button
              type="button"
              onClick={() => onSelect(rec)}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "w-full rounded-md px-3 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none",
                selected && "bg-muted hover:bg-muted",
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
                  from {names.get(rec.depot_id) ?? rec.depot_id}
                  {reasons > 0 ? ` · ${reasons} review reason${reasons === 1 ? "" : "s"}` : ""}
                </span>
                {!helps && saved > 0 ? (
                  // A stockout is certain either way: show the shortage this shipment still removes.
                  <span className="font-mono tabular-nums text-ok-fg" title="Stockout risk unchanged, but this shipment cuts the expected shortage in the next 12 h by this much">
                    −{formatNumber(saved)} L short
                  </span>
                ) : (
                  <span
                    className={cn("inline-flex items-center gap-1 font-mono tabular-nums", !helps && "text-warn-fg")}
                    title={helps ? "Stockout risk in 12 h, without and with this shipment" : "This shipment alone does not lower the 12 h stockout risk"}
                  >
                    {formatProbability(rec.risk_before)}
                    <ArrowRight {...ICON_SM} size={12} aria-label="to" role="img" />
                    {formatProbability(rec.risk_after)}
                  </span>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
