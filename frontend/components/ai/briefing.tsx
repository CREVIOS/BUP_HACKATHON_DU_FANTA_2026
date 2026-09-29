"use client";

import { ArrowClockwise, ArrowRight, CheckCircle, Info, Warning, WarningCircle, WarningOctagon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ICON, ICON_SM } from "@/components/icon-props";
import { useNavigate } from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { BriefChanges, BriefItem, BriefResponse } from "@/lib/ai/brief";
import type { Tab, Target } from "@/lib/targets";

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
// While the model writes notes in the background, ask again this often, for about a minute at most.
const NOTES_POLL_MS = 5_000;
const NOTES_POLL_MAX = 12;
const MAX_CHANGES = 4;
const TAB_LABEL: Record<Tab, string> = { live: "Live", overview: "Overview", decisions: "Decisions", network: "Network", control: "Control" };
const linkLabel = (target: Target) => (target.seriesKey ? "Review" : `Open ${TAB_LABEL[target.tab]}`);

function SourceChip({ brief }: { brief: BriefResponse }) {
  const ai = brief.source === "ai";
  return (
    <span
      title={ai ? "Summary and notes written by the language model; every problem and figure is computed by code" : "Computed from live data; no language model notes"}
      className="rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground"
    >
      {ai ? "AI" : "Rules"}
    </span>
  );
}

async function requestBrief(refresh: boolean, signal?: AbortSignal): Promise<BriefResponse> {
  const res = await fetch(refresh ? "/ai/brief?refresh=1" : "/ai/brief", { cache: "no-store", signal });
  if (!res.ok) throw new Error(`brief returned ${res.status}`);
  return (await res.json()) as BriefResponse;
}

// Loads the briefing on mount, then again when the tick has moved past the tick of the brief on screen
// (checked every 20 s, so a fast simulator does not cost a model call per tick). Only one request is
// in flight: starting a new one aborts the previous, so an old answer can never overwrite a newer one.
export function useBrief(tick: number | undefined) {
  const [brief, setBrief] = useState<BriefResponse>();
  const [loading, setLoading] = useState(true); // true until the first answer or failure
  const [failed, setFailed] = useState(false);
  const tickRef = useRef<number | undefined>(tick);
  const shownTick = useRef<number | undefined>(undefined);
  const inflight = useRef<AbortController | undefined>(undefined);
  const notesPoll = useRef<{ timer?: ReturnType<typeof setTimeout>; count: number }>({ count: 0 });

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  const run = useCallback(
    function load(refresh: boolean) {
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      requestBrief(refresh, controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return;
          setBrief(next);
          setFailed(false);
          shownTick.current = next.tick;
          const poll = notesPoll.current;
          clearTimeout(poll.timer);
          poll.count = next.notesPending ? poll.count + 1 : 0;
          if (next.notesPending && poll.count <= NOTES_POLL_MAX) poll.timer = setTimeout(() => load(false), NOTES_POLL_MS);
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
    [],
  );

  useEffect(() => {
    run(false);
    const timer = setInterval(() => {
      if (tickRef.current !== shownTick.current) run(false);
    }, REFRESH_CHECK_MS);
    const poll = notesPoll.current;
    return () => {
      clearInterval(timer);
      clearTimeout(poll.timer);
      inflight.current?.abort();
    };
  }, [run]);

  const refresh = useCallback(() => {
    setLoading(true);
    run(true);
  }, [run]);

  return { brief, loading, failed, refresh };
}

// What changed since the previous briefing: problems that appeared, got worse, or cleared.
function Changes({ changes }: { changes: BriefChanges }) {
  const rows = [
    ...changes.added.map((title) => ({ kind: "New", tone: "text-bad-fg", title })),
    ...changes.worse.map((title) => ({ kind: "Worse", tone: "text-warn-fg", title })),
    ...changes.resolved.map((title) => ({ kind: "Cleared", tone: "text-ok-fg", title })),
  ];
  if (rows.length === 0) return null;
  return (
    <div className="mt-4 rounded-md bg-muted/60 px-3 py-2 text-xs">
      <p className="font-medium text-muted-foreground">Since tick {changes.sinceTick}</p>
      <ul className="mt-1 space-y-0.5">
        {rows.slice(0, MAX_CHANGES).map((row) => (
          <li key={`${row.kind}:${row.title}`}>
            <span className={`font-medium ${row.tone}`}>{row.kind}</span> {row.title}
          </li>
        ))}
        {rows.length > MAX_CHANGES ? <li className="text-muted-foreground">and {rows.length - MAX_CHANGES} more</li> : null}
      </ul>
    </div>
  );
}

// One problem: computed title and figures, the model's note (marked with a bar), and a link to act on it.
function Item({ item }: { item: BriefItem }) {
  const go = useNavigate();
  const { Icon, className } = SEVERITY_ICON[item.severity];
  return (
    <li className="flex gap-3">
      <Icon {...ICON} weight="fill" className={`mt-0.5 shrink-0 ${className}`} role="img" aria-label={item.severity} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{item.title}</p>
        {item.detail ? <p className="text-sm text-muted-foreground">{item.detail}</p> : null}
        {item.note ? <p className="mt-1 border-l-2 border-foreground/25 pl-2 text-sm">{item.note}</p> : null}
      </div>
      <Button variant="ghost" size="xs" className="shrink-0 self-start" onClick={() => go(item.target)} aria-label={`${linkLabel(item.target)}: ${item.title}`}>
        {linkLabel(item.target)}
        <ArrowRight {...ICON_SM} aria-hidden />
      </Button>
    </li>
  );
}

export function Briefing({ tick }: { tick?: number }) {
  const { brief, loading, failed, refresh } = useBrief(tick);

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
          {brief.summary ? <p className="mt-2 max-w-prose text-sm">{brief.summary}</p> : null}
          {brief.changes ? <Changes changes={brief.changes} /> : null}
          {brief.items.length > 0 ? (
            <ul className="mt-4 space-y-3">
              {brief.items.map((item) => (
                <Item key={item.id} item={item} />
              ))}
            </ul>
          ) : null}
          <p className="mt-4 text-xs text-muted-foreground">
            Figures from tick {brief.tick}, computed from live data.
            {brief.source === "ai" && brief.notesTick !== undefined
              ? ` Summary and notes (marked with a bar) written by AI at tick ${brief.notesTick}; any that quoted a figure not in the data were discarded.`
              : ""}
            {brief.notesPending ? " AI is writing notes for the latest state…" : ""}
          </p>
          {failed ? <p className="mt-3 text-xs text-warn-fg">Showing the previous briefing. Refresh failed.</p> : null}
        </div>
      )}
    </div>
  );
}
