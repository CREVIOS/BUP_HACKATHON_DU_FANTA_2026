"use client";

import { useState } from "react";
import { ActionError } from "@/components/action-error";
import { FIELD, LABEL } from "@/components/form-styles";
import { QueryBlock } from "@/components/query-block";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { usePolicy, useUpdatePolicy } from "@/lib/api/hooks";
import type { Policy } from "@/lib/api/schemas";

function PolicyForm({ policy }: { policy: Policy }) {
  const update = useUpdatePolicy();
  const [threshold, setThreshold] = useState(String(policy.jev_threshold));
  const t = Number(threshold);
  const tValid = t > 0 && t <= 1;

  return (
    <div className="space-y-4">
      <label className="flex items-center justify-between gap-4">
        <span>
          <span className="block text-sm">Auto-execute safe recommendations</span>
          <span className="block text-xs text-muted-foreground">Off: every recommendation waits for a human.</span>
        </span>
        <Switch checked={policy.auto_execute} disabled={update.isPending} onCheckedChange={(checked) => update.mutate({ auto_execute: checked })} />
      </label>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (tValid) update.mutate({ jev_threshold: t });
        }}
      >
        <label className="w-40">
          <span className={LABEL}>Jev auto threshold (0 to 1)</span>
          <input className={FIELD} inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} aria-invalid={!tValid} />
        </label>
        <Button type="submit" variant="outline" disabled={!tValid || t === policy.jev_threshold || update.isPending}>
          Save
        </Button>
        {!policy.jev_configured ? <span className="pb-2 text-xs text-muted-foreground">Jev is not configured; the fixed rule decides.</span> : null}
      </form>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground">How review is decided ({policy.policy_version})</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {policy.review_rule.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </details>
      <ActionError error={update.error} />
    </div>
  );
}

export function PolicyPanel() {
  const policy = usePolicy();
  return <QueryBlock query={policy}>{(data) => <PolicyForm key={`${data.auto_execute}:${data.jev_threshold}`} policy={data} />}</QueryBlock>;
}
