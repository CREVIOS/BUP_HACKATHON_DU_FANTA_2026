"use client";

import { QueryBlock } from "@/components/query-block";
import { useIntelQuality } from "@/lib/api/hooks";
import { formatNumber, humanize } from "@/lib/format";

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-medium">{value}</dd>
      {note ? <dd className="text-xs text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

const pct = (v: number | null | undefined) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);

// Evidence that the intelligence works (brief section 14, intelligence layer): forecast error vs a
// naive baseline, how triage decided, and what happened to recommendations.
export function IntelQuality() {
  const quality = useIntelQuality();
  return (
    <QueryBlock query={quality}>
      {(q) => (
        <div className="space-y-5">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
            <Figure label="Forecast error (MAPE)" value={pct(q.forecast.mape)} note={`naive baseline ${pct(q.forecast.naive_mape)}`} />
            <Figure label="Observations" value={formatNumber(q.forecast.observations)} note={`last ${q.window_ticks} ticks`} />
            <Figure label="Jev asked" value={formatNumber(q.jev.asked)} note={q.jev.avg_p_auto == null ? "not configured or not asked" : `avg confidence ${pct(q.jev.avg_p_auto)}`} />
            <Figure label="Jev vs rule" value={`${q.jev.agreed_with_rule} agree`} note={`${q.jev.overrode_rule} overrode the rule`} />
          </dl>
          <p className="text-xs text-muted-foreground">
            Recommendations:{" "}
            {Object.entries(q.recommendations.by_status)
              .map(([k, v]) => `${v} ${humanize(k).toLowerCase()}`)
              .join(", ") || "none"}
            . {q.forecast.note}
          </p>
        </div>
      )}
    </QueryBlock>
  );
}
