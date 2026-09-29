"use client";

import { useState } from "react";
import { ActionError } from "@/components/action-error";
import { Button } from "@/components/ui/button";
import { usePause, useReset, useRun, useStep } from "@/lib/api/hooks";
import type { Overview } from "@/lib/api/schemas";

// Drives the simulator for the demo (brief section 22): the api queues the command, the ingestor runs it.
export function SimControls({ overview }: { overview?: Overview }) {
  const step = useStep();
  const run = useRun();
  const pause = usePause();
  const reset = useReset();
  const [confirmReset, setConfirmReset] = useState(false);
  const running = overview?.sim_status === "RUNNING";
  const busy = step.isPending || run.isPending || pause.isPending || reset.isPending;
  const error = step.error ?? run.error ?? pause.error ?? reset.error;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Tick <span className="font-mono text-foreground">{overview?.tick ?? "n/a"}</span>, {running ? "running" : "paused"}.
        {step.isPending ? " Stepping, each tick runs the full decide and submit cycle." : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        {[1, 4, 12].map((count) => (
          <Button key={count} variant="outline" disabled={busy || running} onClick={() => step.mutate(count)}>
            Step {count}
          </Button>
        ))}
        {running ? (
          <Button variant="outline" disabled={busy} onClick={() => pause.mutate(undefined)}>
            Pause
          </Button>
        ) : (
          <Button variant="outline" disabled={busy} onClick={() => run.mutate(undefined)}>
            Run
          </Button>
        )}
        {confirmReset ? (
          <>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirmReset(false);
                reset.mutate(undefined);
              }}
            >
              Confirm reset to tick 0
            </Button>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              Keep going
            </Button>
          </>
        ) : (
          <Button variant="ghost" disabled={busy} onClick={() => setConfirmReset(true)}>
            Reset
          </Button>
        )}
      </div>
      <ActionError error={error} />
    </div>
  );
}
