"use client";

import { useState } from "react";
import { ActionDone, ActionError } from "@/components/action-error";
import { FIELD, LABEL, TEXTAREA } from "@/components/form-styles";
import { Button } from "@/components/ui/button";
import { useAccess } from "@/hooks/use-access";
import { useApprove, useReject, useSimulate } from "@/lib/api/hooks";
import type { Recommendation } from "@/lib/api/schemas";
import { formatHours, formatProbability } from "@/lib/format";

// Approve (optionally with an edited quantity), reject with a reason, or test a quantity first.
// The API re-validates everything; these checks only stop obviously bad input early.
export function DecisionForm({ rec }: { rec: Recommendation }) {
  const access = useAccess();
  const approve = useApprove();
  const reject = useReject();
  const simulate = useSimulate();
  const [quantity, setQuantity] = useState(String(rec.quantity));
  const [reason, setReason] = useState("");
  const qty = Number(quantity);
  const qtyValid = Number.isFinite(qty) && qty > 0;
  const edited = qtyValid && qty !== rec.quantity;
  const busy = approve.isPending || reject.isPending;

  if (!access.can("approve")) {
    return <p className="text-sm text-muted-foreground">{access.needs("approve")}</p>;
  }
  if (approve.isSuccess) return <ActionDone>Approved. It goes to the simulator within a second.</ActionDone>;
  if (reject.isSuccess) return <ActionDone>Rejected. The reason is in the decision history.</ActionDone>;

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        approve.mutate({ id: rec.id, reason: reason.trim() || undefined, quantity: edited ? qty : undefined });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <label>
          <span className={LABEL}>Quantity (L)</span>
          <input
            className={FIELD}
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value.replace(/[^\d.]/g, ""))}
            aria-invalid={!qtyValid}
          />
        </label>
        <label>
          <span className={LABEL}>Reason (required to reject)</span>
          <textarea className={TEXTAREA} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} rows={2} />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !qtyValid}>
          {edited ? `Approve ${qty.toLocaleString("en-US")} L` : "Approve"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || reason.trim() === ""}
          title={reason.trim() === "" ? "Write a reason first" : undefined}
          onClick={() => reject.mutate({ id: rec.id, reason: reason.trim() })}
        >
          Reject
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!qtyValid || simulate.isPending}
          onClick={() => simulate.mutate({ station_id: rec.station_id, fuel_type: rec.fuel_type, route_id: rec.route_id, quantity: qty })}
        >
          What if?
        </Button>
      </div>
      {simulate.data ? (
        <div className={`rounded-md px-3 py-2 text-sm ${simulate.data.valid ? "bg-muted" : "bg-bad-bg text-bad-fg"}`}>
          {simulate.data.valid ? (
            <p>
              {qty.toLocaleString("en-US")} L arrives at tick {simulate.data.arrival_tick}. Stockout risk {formatProbability(simulate.data.before?.stockout_prob)} to{" "}
              {formatProbability(simulate.data.after?.stockout_prob)}, stockout {formatHours(simulate.data.before?.time_to_stockout_hours)} to{" "}
              {formatHours(simulate.data.after?.time_to_stockout_hours)}.
            </p>
          ) : (
            <>
              <p>This quantity would be rejected or lose fuel:</p>
              <ul className="mt-1 list-disc pl-5 text-xs">
                {simulate.data.violations.map((v) => (
                  <li key={v}>{v}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
      <ActionError error={approve.error ?? reject.error ?? simulate.error} />
    </form>
  );
}
