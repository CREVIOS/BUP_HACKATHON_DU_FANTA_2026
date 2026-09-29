"use client";

import { useMemo, useState } from "react";
import { ActionDone, ActionError } from "@/components/action-error";
import { SelectField } from "@/components/select-field";
import { FIELD, LABEL, TEXTAREA } from "@/components/form-styles";
import { FUELS } from "@/components/inventory-table";
import { Button } from "@/components/ui/button";
import { useAccess } from "@/hooks/use-access";
import { useAllocate, useNetwork, useSimulate } from "@/lib/api/hooks";
import type { Fuel } from "@/lib/api/schemas";
import { formatHours, formatNumber, formatProbability, humanize } from "@/lib/format";

// The operator's own shipment (docs/API.md 5.13): check it with a what-if, then send it.
export function ManualAllocation() {
  const access = useAccess();
  const network = useNetwork();
  const simulate = useSimulate();
  const allocate = useAllocate();
  const stations = network.data?.stations ?? [];
  const [stationId, setStationId] = useState("");
  const [fuel, setFuel] = useState<Fuel>("DIESEL");
  const [routeId, setRouteId] = useState("");
  const [quantity, setQuantity] = useState("3000");
  const [reason, setReason] = useState("");

  const station = stationId || stations[0]?.id || "";
  const routes = useMemo(() => (network.data?.routes ?? []).filter((r) => r.destination_station_id === station), [network.data, station]);
  const route = routes.some((r) => r.id === routeId) ? routeId : (routes.find((r) => r.usable_now) ?? routes[0])?.id ?? "";
  const qty = Number(quantity);
  const proposal = { station_id: station, fuel_type: fuel, route_id: route, quantity: qty };
  const checked = simulate.data && simulate.variables && JSON.stringify(simulate.variables) === JSON.stringify(proposal);
  const room = network.data?.stations.find((s) => s.id === station)?.fuels[fuel]?.room_after_in_transit;

  if (!access.can("allocate")) return <p className="text-sm text-muted-foreground">{access.needs("allocate")}</p>;
  if (allocate.isSuccess) {
    return (
      <div className="space-y-3">
        <ActionDone>Shipment approved and queued for the simulator.</ActionDone>
        <Button variant="ghost" size="sm" onClick={() => allocate.reset()}>
          New shipment
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        allocate.mutate({ ...proposal, reason: reason.trim() });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label>
          <span className={LABEL}>Station</span>
          <SelectField value={station} onChange={(e) => setStationId(e.target.value)}>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>
        </label>
        <label>
          <span className={LABEL}>Fuel</span>
          <SelectField value={fuel} onChange={(e) => setFuel(e.target.value as Fuel)}>
            {FUELS.map((f) => (
              <option key={f} value={f}>
                {humanize(f)}
              </option>
            ))}
          </SelectField>
        </label>
        <label>
          <span className={LABEL}>Route</span>
          <SelectField value={route} onChange={(e) => setRouteId(e.target.value)}>
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.source_depot_id.replace("depot-", "")}, {r.transit_ticks} ticks{r.usable_now ? "" : " (not usable now)"}
              </option>
            ))}
          </SelectField>
        </label>
        <label>
          <span className={LABEL}>Quantity (L){room !== undefined ? `, room ${formatNumber(room)}` : ""}</span>
          <input className={FIELD} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^\d.]/g, ""))} />
        </label>
      </div>
      <label className="block">
        <span className={LABEL}>Reason (required)</span>
        <textarea className={TEXTAREA} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={!route || !(qty > 0) || simulate.isPending} onClick={() => simulate.mutate(proposal)}>
          Check
        </Button>
        <Button type="submit" disabled={!checked || !simulate.data?.valid || reason.trim() === "" || allocate.isPending}>
          Send shipment
        </Button>
      </div>
      {checked && simulate.data ? (
        <div className={`rounded-md px-3 py-2 text-sm ${simulate.data.valid ? "bg-muted" : "bg-bad-bg text-bad-fg"}`}>
          {simulate.data.valid ? (
            <p>
              Safe to send. Arrives tick {simulate.data.arrival_tick}; stockout risk {formatProbability(simulate.data.before?.stockout_prob)} to{" "}
              {formatProbability(simulate.data.after?.stockout_prob)}, stockout {formatHours(simulate.data.before?.time_to_stockout_hours)} to{" "}
              {formatHours(simulate.data.after?.time_to_stockout_hours)}.
            </p>
          ) : (
            <ul className="list-disc pl-5 text-xs">
              {simulate.data.violations.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Check the shipment first: sending is enabled once it is safe.</p>
      )}
      <ActionError error={simulate.error ?? allocate.error} />
    </form>
  );
}
