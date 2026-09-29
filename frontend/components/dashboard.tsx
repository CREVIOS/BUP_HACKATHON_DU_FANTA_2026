"use client";

import { GasPump } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { AskAssistant } from "@/components/ai/ask-assistant";
import { DegradedBanner } from "@/components/degraded-banner";
import { ICON } from "@/components/icon-props";
import { NavigationProvider } from "@/components/navigation";
import { StreamIndicator } from "@/components/stream-indicator";
import { ControlTab } from "@/components/tabs/control-tab";
import { DecisionsTab } from "@/components/tabs/decisions-tab";
import { LiveTab } from "@/components/tabs/live-tab";
import { NetworkTab } from "@/components/tabs/network-tab";
import { OverviewTab } from "@/components/tabs/overview-tab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useNetwork, useOverview, useStatus } from "@/lib/api/hooks";
import type { Tab, Target } from "@/lib/targets";
import { deriveNetworkView } from "@/lib/view";

export function Dashboard() {
  const [tab, setTab] = useState<Tab>("live");
  // A navigation request: which recommendation to open in Decisions, which section to scroll to.
  // `nonce` remounts Decisions so a new focus always applies.
  const [focus, setFocus] = useState<{ seriesKey?: string; section?: string; nonce: number }>({ nonce: 0 });
  const go = (target: Target) => {
    setTab(target.tab);
    setFocus((f) => ({ seriesKey: target.seriesKey, section: target.section, nonce: f.nonce + 1 }));
  };

  useEffect(() => {
    if (focus.nonce === 0) return;
    if (!focus.section) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    // The tab's panel (and its data) may render a moment later: retry briefly until the section exists.
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const scroll = () => {
      const element = document.getElementById(focus.section ?? "");
      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      if (element) element.scrollIntoView({ behavior, block: "start" });
      else if (++attempts < 20) timer = setTimeout(scroll, 50);
    };
    timer = setTimeout(scroll, 0);
    return () => clearTimeout(timer);
  }, [focus]);

  const overview = useOverview();
  const network = useNetwork();
  const status = useStatus();
  const view = useMemo(() => (network.data ? deriveNetworkView(network.data) : undefined), [network.data]);
  const names = view?.names ?? new Map<string, string>();
  const queue = overview.data?.review_queue ?? 0;
  const critical = overview.data?.open_alerts.critical ?? 0;

  return (
    <NavigationProvider value={go}>
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24 sm:px-6">
      <header className="flex items-center justify-between gap-4 py-5">
        <h1 className="flex items-center gap-2 text-base font-medium tracking-tight">
          <GasPump {...ICON} weight="fill" aria-hidden />
          FuelOps
        </h1>
        <div className="flex items-center gap-3">
          <StreamIndicator updatedAt={overview.dataUpdatedAt} />
        </div>
      </header>

      <DegradedBanner overview={overview.data} status={status.data} error={overview.error ?? network.error} updatedAt={overview.dataUpdatedAt} />

      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList variant="line" className="mb-2 w-full justify-start gap-4 overflow-x-auto">
          <TabsTrigger value="live" className="flex-none px-0">
            Live
          </TabsTrigger>
          <TabsTrigger value="overview" className="flex-none px-0">
            Overview
            {critical > 0 ? <span className="rounded-full bg-bad-bg px-1.5 text-[0.6875rem] text-bad-fg">{critical}</span> : null}
          </TabsTrigger>
          <TabsTrigger value="decisions" className="flex-none px-0">
            Decisions
            {queue > 0 ? <span className="rounded-full bg-warn-bg px-1.5 text-[0.6875rem] text-warn-fg">{queue}</span> : null}
          </TabsTrigger>
          <TabsTrigger value="network" className="flex-none px-0">
            Network
          </TabsTrigger>
          <TabsTrigger value="control" className="flex-none px-0">
            Control
          </TabsTrigger>
        </TabsList>
        <TabsContent value="live">
          <LiveTab names={names} />
        </TabsContent>
        <TabsContent value="overview">
          <OverviewTab names={names} />
        </TabsContent>
        <TabsContent value="decisions">
          <DecisionsTab key={focus.nonce} names={names} focusKey={focus.seriesKey} />
        </TabsContent>
        <TabsContent value="network">
          <NetworkTab view={view} />
        </TabsContent>
        <TabsContent value="control">
          <ControlTab />
        </TabsContent>
      </Tabs>

      <AskAssistant tick={overview.data?.tick} />
    </main>
    </NavigationProvider>
  );
}
