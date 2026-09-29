"use client";

import { AccessPanel } from "@/components/control/access-panel";
import { CommandLog } from "@/components/control/command-log";
import { CrisisForm } from "@/components/control/crisis-form";
import { FaultForm } from "@/components/control/fault-form";
import { PolicyPanel } from "@/components/control/policy-panel";
import { SimControls } from "@/components/control/sim-controls";
import { Section } from "@/components/section";
import { useAccess } from "@/hooks/use-access";
import { useNetwork, useOverview } from "@/lib/api/hooks";

export function ControlTab() {
  const access = useAccess();
  const overview = useOverview();
  const network = useNetwork();
  const admin = access.can("control");
  return (
    <>
      <Section title="Access">
        <AccessPanel />
      </Section>
      {admin ? (
        <>
          <Section title="Simulator">
            <SimControls overview={overview.data} />
          </Section>
          <Section title="Inject a crisis">
            <CrisisForm network={network.data} />
          </Section>
          <Section title="Inject a software fault">
            <FaultForm />
          </Section>
          <Section title="Decision policy">
            <PolicyPanel />
          </Section>
        </>
      ) : (
        <p className="border-t py-8 text-sm text-muted-foreground">{access.needs("control")}</p>
      )}
      <Section title="Command log">
        <CommandLog enabled={admin} />
      </Section>
    </>
  );
}
