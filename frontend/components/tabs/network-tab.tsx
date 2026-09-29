"use client";

import { Allocations, Events, IncomingSupply } from "@/components/activity";
import { InventoryTable } from "@/components/inventory-table";
import { DemandChart } from "@/components/network/demand-chart";
import { RegionalDemand } from "@/components/network/regional-demand";
import { NetworkTable } from "@/components/network-table";
import { QueryBlock } from "@/components/query-block";
import { Section } from "@/components/section";
import { useAllocations, useEvents, useNetwork, useOverview, useSupply } from "@/lib/api/hooks";
import type { NetworkView } from "@/lib/view";

export function NetworkTab({ view }: { view?: NetworkView }) {
  const network = useNetwork();
  const overview = useOverview();
  const events = useEvents();
  const allocations = useAllocations();
  const supply = useSupply();
  const names = view?.names ?? new Map<string, string>();
  return (
    <>
      <Section title="Stations">
        <QueryBlock query={network} rows={4}>
          {() => (
            <InventoryTable
              label="Station"
              rows={view?.stations ?? []}
              note="Coloured by projected stockout risk; hours shown when a stockout is expected within 12 h"
            />
          )}
        </QueryBlock>
      </Section>
      <Section title="Depots">
        <QueryBlock query={network} rows={2}>
          {() => <InventoryTable label="Depot" rows={view?.depots ?? []} />}
        </QueryBlock>
      </Section>
      <Section title="Routes">
        <QueryBlock query={network} rows={4}>
          {(data) => <NetworkTable routes={data.routes} names={names} tickMinutes={overview.data?.tick_minutes ?? 15} />}
        </QueryBlock>
      </Section>
      <Section title="Demand and forecast">
        <QueryBlock query={network}>{(data) => <DemandChart stations={data.stations} now={overview.data?.tick ?? data.tick} />}</QueryBlock>
      </Section>
      <Section title="Regional demand, last 24 hours">
        <RegionalDemand />
      </Section>
      <Section title="Activity">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
          <QueryBlock query={events}>{(data) => <Events events={data.events} />}</QueryBlock>
          <QueryBlock query={allocations}>{(data) => <Allocations allocations={data.allocations} names={names} />}</QueryBlock>
          <QueryBlock query={supply}>{(data) => <IncomingSupply arrivals={data.arrivals} names={names} />}</QueryBlock>
        </div>
      </Section>
    </>
  );
}
