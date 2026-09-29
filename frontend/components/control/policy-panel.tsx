"use client";

import { ActionError } from "@/components/action-error";
import { QueryBlock } from "@/components/query-block";
import { Switch } from "@/components/ui/switch";
import { usePolicy, useUpdatePolicy } from "@/lib/api/hooks";
import type { Policy } from "@/lib/api/schemas";

// The backend lists the Jev step of its review rule; Jev is not part of this pipeline, so show the hard
// vetoes and the fixed rule only.
function reviewRule(lines: readonly string[]): string[] {
  return lines.filter((line) => !/^otherwise jev\b/i.test(line)).map((line) => line.replace(/^if jev is off or fails,\s*/i, ""));
}

function PolicyForm({ policy }: { policy: Policy }) {
  const update = useUpdatePolicy();

  return (
    <div className="space-y-4">
      <label className="flex items-center justify-between gap-4">
        <span>
          <span className="block text-sm">Auto-execute safe recommendations</span>
          <span className="block text-xs text-muted-foreground">Off: every recommendation waits for a human.</span>
        </span>
        <Switch checked={policy.auto_execute} disabled={update.isPending} onCheckedChange={(checked) => update.mutate({ auto_execute: checked })} />
      </label>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground">How review is decided ({policy.policy_version})</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {reviewRule(policy.review_rule).map((rule) => (
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
  return <QueryBlock query={policy}>{(data) => <PolicyForm key={String(data.auto_execute)} policy={data} />}</QueryBlock>;
}
