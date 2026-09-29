"use client";

import { Briefing } from "@/components/ai/briefing";
import { NetworkMap } from "@/components/map/network-map";
import { AlertsPanel } from "@/components/overview/alerts-panel";
import { RiskTable } from "@/components/overview/risk-table";
import { QueryBlock } from "@/components/query-block";
import { Section } from "@/components/section";
import { SimulationPanel } from "@/components/simulation-panel";
import { SystemStatus } from "@/components/system-status";
import { useOverview, useStatus } from "@/lib/api/hooks";

export function OverviewTab({ names }: { names: ReadonlyMap<string, string> }) {
  const overview = useOverview();
  const status = useStatus();
  return (
    <>
      <section id="map" className="grid scroll-mt-4 gap-10 border-t py-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h2 className="mb-4 text-sm font-medium">Network map</h2>
          <NetworkMap names={names} />
        </div>
        <div className="min-w-0">
          <h2 className="mb-4 text-sm font-medium">Briefing</h2>
          {overview.data ? <Briefing tick={overview.data.tick} /> : null}
        </div>
      </section>
      <Section title="Simulation">
        <QueryBlock query={overview}>{(data) => <SimulationPanel overview={data} />}</QueryBlock>
      </Section>
      <Section id="alerts" title="Open alerts">
        <AlertsPanel names={names} />
      </Section>
      <Section id="risk" title="Shortage risk, next 12 hours">
        <RiskTable />
      </Section>
      <Section id="system" title="System status">
        <SystemStatus status={status.data} loading={status.isPending} />
      </Section>
    </>
  );
}
