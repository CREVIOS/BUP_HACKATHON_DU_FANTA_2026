"use client";

import { useState } from "react";
import { ActionDone, ActionError } from "@/components/action-error";
import { FIELD, LABEL } from "@/components/form-styles";
import { Button } from "@/components/ui/button";
import { useClearFaults, useInjectFault } from "@/lib/api/hooks";
import { buildFaultBody, type FaultType } from "@/lib/crisis";
import { humanize } from "@/lib/format";

const TYPES: readonly { type: FaultType; hint: string }[] = [
  { type: "unavailable", hint: "every simulator request fails with 503" },
  { type: "latency", hint: "every simulator request is delayed" },
  { type: "error_rate", hint: "a share of simulator requests fail" },
  { type: "stale_data", hint: "the simulator flags its data stale" },
  { type: "stream_disconnect", hint: "new simulator event streams are refused" },
];

// Software faults for the resilience demo (brief section 11). They last a wall-clock duration.
export function FaultForm() {
  const inject = useInjectFault();
  const clear = useClearFaults();
  const [type, setType] = useState<FaultType>("unavailable");
  const [seconds, setSeconds] = useState(60);
  const [value, setValue] = useState(800);
  const [problem, setProblem] = useState<string>();
  const takesValue = type === "latency" || type === "error_rate";

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const built = buildFaultBody({ type, durationSeconds: seconds, value: takesValue ? value : undefined });
        if (!built.ok) return setProblem(built.error);
        setProblem(undefined);
        clear.reset();
        inject.mutate(built.body);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <label>
          <span className={LABEL}>Fault</span>
          <select
            className={FIELD}
            value={type}
            onChange={(e) => {
              const next = e.target.value as FaultType;
              setType(next);
              setValue(next === "error_rate" ? 0.25 : 800);
            }}
          >
            {TYPES.map((t) => (
              <option key={t.type} value={t.type}>
                {humanize(t.type)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={LABEL}>Duration (seconds)</span>
          <input className={FIELD} type="number" min={1} max={3600} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
        </label>
        {takesValue ? (
          <label>
            <span className={LABEL}>{type === "latency" ? "Delay (ms)" : "Failure rate (0 to 1)"}</span>
            <input className={FIELD} type="number" step={type === "latency" ? 100 : 0.05} value={value} onChange={(e) => setValue(Number(e.target.value))} />
          </label>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{TYPES.find((t) => t.type === type)?.hint}.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={inject.isPending}>
          Inject fault
        </Button>
        <Button type="button" variant="outline" disabled={clear.isPending} onClick={() => {
            inject.reset();
            clear.mutate(undefined);
          }}>
          Clear all faults
        </Button>
      </div>
      {problem ? <p className="text-sm text-bad-fg">{problem}</p> : null}
      {inject.isSuccess ? <ActionDone>Fault active. System status and the banner should react within seconds.</ActionDone> : null}
      {clear.isSuccess ? <ActionDone>Faults cleared.</ActionDone> : null}
      <ActionError error={inject.error ?? clear.error} />
    </form>
  );
}
