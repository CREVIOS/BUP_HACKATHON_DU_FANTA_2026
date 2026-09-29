"use client";

import { Briefing } from "@/components/ai/briefing";
import { AlertsPanel } from "@/components/overview/alerts-panel";
import { RiskTable } from "@/components/overview/risk-table";
import { QueryBlock } from "@/components/query-block";
import { Section } from "@/components/section";
import { SimulationPanel } from "@/components/simulation-panel";
import { SystemStatus } from "@/components/system-status";
import { useOverview, useStatus } from "@/lib/api/hooks";
import type { Scenario } from "@/lib/mock/scenarios";

export function OverviewTab({ scenario, names }: { scenario?: Scenario; names: ReadonlyMap<string, string> }) {
  const overview = useOverview();
  const status = useStatus();
  return (
    <>
      {overview.data ? (
        <Section title="Briefing">
          <Briefing key={scenario ?? "live"} scenario={scenario} tick={overview.data.tick} />
        </Section>
      ) : null}
      <Section title="Simulation">
        <QueryBlock query={overview}>{(data) => <SimulationPanel overview={data} />}</QueryBlock>
      </Section>
      <Section title="Open alerts">
        <AlertsPanel names={names} />
      </Section>
      <Section title="Shortage risk, next 12 hours">
        <RiskTable />
      </Section>
      <Section title="System status">
        <SystemStatus status={status.data} loading={status.isPending} />
      </Section>
    </>
  );
}
