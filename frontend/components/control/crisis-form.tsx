"use client";

import { useState } from "react";
import { ActionDone, ActionError } from "@/components/action-error";
import { SelectField } from "@/components/select-field";
import { FIELD, LABEL } from "@/components/form-styles";
import { Button } from "@/components/ui/button";
import { useInjectEvent } from "@/lib/api/hooks";
import type { Network } from "@/lib/api/schemas";
import { buildEventBody, EVENT_TARGET, type CrisisForm as Form, type EventType } from "@/lib/crisis";
import { humanize } from "@/lib/format";

const TYPES = Object.keys(EVENT_TARGET) as EventType[];

// Ready-made crises for the live demo (brief section 10).
const PRESETS: readonly { label: string; form: Form }[] = [
  { label: "Dhaka demand spike ×1.8", form: { type: "demand_spike", targetIds: ["region-dhaka"], startIn: 0, duration: 16, multiplier: 1.8 } },
  { label: "Gazipur to Mirpur disrupted", form: { type: "route_disruption", targetIds: ["route-gazipur-mirpur"], startIn: 1, duration: 6 } },
  { label: "Patiya supply 50% short", form: { type: "supply_shortfall", targetIds: ["depot-patiya"], startIn: 0, duration: 1, factor: 0.5 } },
];

function targetsFor(network: Network | undefined, type: EventType): { id: string; name: string }[] {
  if (!network) return [];
  switch (EVENT_TARGET[type].kind) {
    case "region":
      return network.regions.map((r) => ({ id: r.id, name: r.name }));
    case "station":
      return network.stations.map((s) => ({ id: s.id, name: s.name }));
    case "depot":
      return network.depots.map((d) => ({ id: d.id, name: d.name }));
    case "route":
      return network.routes.map((r) => ({ id: r.id, name: r.id.replace("route-", "").replace("-", " to ") }));
  }
}

export function CrisisForm({ network }: { network?: Network }) {
  const inject = useInjectEvent();
  const [form, setForm] = useState<Form>({ type: "demand_spike", targetIds: [], startIn: 0, duration: 12, multiplier: 1.5 });
  const [problem, setProblem] = useState<string>();
  const targets = targetsFor(network, form.type);
  const kind = EVENT_TARGET[form.type].kind;
  const update = (patch: Partial<Form>) => {
    setProblem(undefined);
    inject.reset();
    setForm((f) => ({ ...f, ...patch }));
  };

  function submit(next: Form) {
    const built = buildEventBody(next);
    if (!built.ok) return setProblem(built.error);
    inject.mutate(built.body);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <Button key={preset.label} variant="outline" size="sm" disabled={inject.isPending} onClick={() => submit(preset.form)}>
            {preset.label}
          </Button>
        ))}
      </div>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit(form);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label>
            <span className={LABEL}>Event</span>
            <SelectField value={form.type} onChange={(e) => update({ type: e.target.value as EventType, targetIds: [] })}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {humanize(t)}
                </option>
              ))}
            </SelectField>
          </label>
          <label>
            <span className={LABEL}>Starts in (ticks)</span>
            <input className={FIELD} type="number" min={0} max={2000} value={form.startIn} onChange={(e) => update({ startIn: Number(e.target.value) })} />
          </label>
          <label>
            <span className={LABEL}>Lasts (ticks)</span>
            <input className={FIELD} type="number" min={1} max={2000} value={form.duration} onChange={(e) => update({ duration: Number(e.target.value) })} />
          </label>
          {form.type === "demand_spike" ? (
            <label>
              <span className={LABEL}>Multiplier</span>
              <input className={FIELD} type="number" step={0.1} min={0.05} max={10} value={form.multiplier ?? 1.5} onChange={(e) => update({ multiplier: Number(e.target.value) })} />
            </label>
          ) : form.type === "shipment_delay" ? (
            <label>
              <span className={LABEL}>Delay (ticks)</span>
              <input className={FIELD} type="number" min={1} max={500} value={form.delayTicks ?? 2} onChange={(e) => update({ delayTicks: Number(e.target.value) })} />
            </label>
          ) : form.type === "supply_shortfall" ? (
            <label>
              <span className={LABEL}>Share delivered (0 to 1)</span>
              <input className={FIELD} type="number" step={0.1} min={0} max={1} value={form.factor ?? 0.5} onChange={(e) => update({ factor: Number(e.target.value) })} />
            </label>
          ) : null}
        </div>
        <fieldset>
          <legend className={LABEL}>
            {humanize(kind)}s {EVENT_TARGET[form.type].required ? "(pick at least one)" : "(none picked means all)"}
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {targets.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-foreground"
                  checked={form.targetIds.includes(t.id)}
                  onChange={(e) => update({ targetIds: e.target.checked ? [...form.targetIds, t.id] : form.targetIds.filter((id) => id !== t.id) })}
                />
                {t.name}
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" disabled={inject.isPending}>
          Inject event
        </Button>
      </form>
      {problem ? <p className="text-sm text-bad-fg">{problem}</p> : null}
      {inject.isSuccess ? <ActionDone>Injected. The system re-decides immediately; watch Overview and Decisions.</ActionDone> : null}
      <ActionError error={inject.error} />
    </div>
  );
}
