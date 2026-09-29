"use client";

import { ArrowClockwise, CheckCircle, Info, Warning, WarningCircle, WarningOctagon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ICON } from "@/components/icon-props";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { BriefResponse } from "@/lib/ai/brief";
import type { Scenario } from "@/lib/mock/scenarios";

const STATUS_ICON = {
  stable: { Icon: CheckCircle, className: "text-ok-fg" },
  watch: { Icon: Warning, className: "text-warn-fg" },
  critical: { Icon: WarningOctagon, className: "text-bad-fg" },
} as const;

const SEVERITY_ICON = {
  high: { Icon: WarningOctagon, className: "text-bad-fg" },
  medium: { Icon: Warning, className: "text-warn-fg" },
  low: { Icon: Info, className: "text-info-fg" },
} as const;

const REFRESH_CHECK_MS = 20_000;

function SourceChip({ brief }: { brief: BriefResponse }) {
  const { label, hint } = brief.mock
    ? { label: "Mock", hint: "Written by the mock model, no LLM is connected" }
    : brief.source === "ai"
      ? { label: "AI", hint: "Written by the language model from computed facts" }
      : { label: "Rules", hint: "Built from computed facts without a model" };
  return (
    <span
      title={hint}
      className="rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground"
    >
      {label}
    </span>
  );
}

async function requestBrief(scenario: Scenario | undefined, refresh: boolean, signal?: AbortSignal): Promise<BriefResponse> {
  const query = new URLSearchParams();
  if (scenario) query.set("scenario", scenario);
  if (refresh) query.set("refresh", "1");
  const res = await fetch(`/ai/brief?${query}`, { cache: "no-store", signal });
  if (!res.ok) throw new Error(`brief returned ${res.status}`);
  return (await res.json()) as BriefResponse;
}

// Loads the briefing on mount, then again when the tick has moved past the tick of the brief on screen
// (checked every 20 s, so a fast simulator does not cost a model call per tick). Only one request is
// in flight: starting a new one aborts the previous, so an old answer can never overwrite a newer one.
// Remount with a new key to switch scenario.
export function useBrief(scenario: Scenario | undefined, tick: number | undefined) {
  const [brief, setBrief] = useState<BriefResponse>();
  const [loading, setLoading] = useState(true); // true until the first answer or failure
  const [failed, setFailed] = useState(false);
  const tickRef = useRef<number | undefined>(tick);
  const shownTick = useRef<number | undefined>(undefined);
  const inflight = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  const run = useCallback(
    (refresh: boolean) => {
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      requestBrief(scenario, refresh, controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return;
          setBrief(next);
          setFailed(false);
          shownTick.current = next.tick; // the server may have answered from its short cache
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          console.warn("briefing unavailable", error);
          setFailed(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    },
    [scenario],
  );

  useEffect(() => {
    run(false);
    const timer = setInterval(() => {
      if (tickRef.current !== shownTick.current) run(false);
    }, REFRESH_CHECK_MS);
    return () => {
      clearInterval(timer);
      inflight.current?.abort();
    };
  }, [run]);

  const refresh = useCallback(() => {
    setLoading(true);
    run(true);
  }, [run]);

  return { brief, loading, failed, refresh };
}

export function Briefing({ scenario, tick }: { scenario?: Scenario; tick?: number }) {
  const { brief, loading, failed, refresh } = useBrief(scenario, tick);

  return (
    <div>
      {!brief && loading ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-6 w-2/3 motion-reduce:animate-none" />
          <Skeleton className="h-4 w-full motion-reduce:animate-none" />
          <Skeleton className="h-4 w-5/6 motion-reduce:animate-none" />
        </div>
      ) : !brief ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <WarningCircle {...ICON} aria-hidden />
          Briefing unavailable
          <Button variant="ghost" size="xs" onClick={refresh}>
            Retry
          </Button>
        </p>
      ) : (
        <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-base font-medium">
              {(() => {
                const { Icon, className } = STATUS_ICON[brief.status];
                return <Icon size={20} weight="fill" className={className} aria-hidden />;
              })()}
              {brief.headline}
            </p>
            <span className="flex items-center gap-2">
              <SourceChip brief={brief} />
              <Button variant="ghost" size="icon-sm" onClick={refresh} disabled={loading} aria-label="Refresh briefing">
                <ArrowClockwise {...ICON} className={loading ? "animate-spin motion-reduce:animate-none" : ""} />
              </Button>
            </span>
          </div>
          {brief.items.length > 0 ? (
            <ul className="mt-4 space-y-3">
              {brief.items.map((item, index) => {
                const { Icon, className } = SEVERITY_ICON[item.severity];
                return (
                  <li key={`${index}-${item.title}`} className="flex gap-3">
                    <Icon {...ICON} weight="fill" className={`mt-0.5 shrink-0 ${className}`} role="img" aria-label={item.severity} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{item.title}</p>
                      {item.detail ? <p className="text-sm text-muted-foreground">{item.detail}</p> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {failed ? <p className="mt-3 text-xs text-warn-fg">Showing the previous briefing. Refresh failed.</p> : null}
        </div>
      )}
    </div>
  );
}
