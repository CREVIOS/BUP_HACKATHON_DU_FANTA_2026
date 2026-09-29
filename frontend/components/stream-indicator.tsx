"use client";

import { useMockMode, useStreamState } from "@/lib/api/hooks";
import { formatClock } from "@/lib/format";

const LABEL = { live: "Live", connecting: "Connecting", down: "Polling", off: "" } as const;

// Whether the page is being pushed updates (stream) or polling for them, and when data last arrived.
export function StreamIndicator({ updatedAt }: { updatedAt: number }) {
  const stream = useStreamState();
  const mock = useMockMode();
  if (mock) return null;
  return (
    <p className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex" aria-live="polite">
      <span
        className={`size-1.5 rounded-full ${stream === "live" ? "bg-ok-fg" : stream === "down" ? "bg-warn-fg" : "bg-muted-foreground"}`}
        aria-hidden
      />
      {LABEL[stream]}
      {updatedAt > 0 ? `, ${formatClock(updatedAt)}` : ""}
    </p>
  );
}
