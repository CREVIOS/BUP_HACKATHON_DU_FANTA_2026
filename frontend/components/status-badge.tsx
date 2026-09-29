import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/tone";

const TONES: Record<Tone, string> = {
  ok: "bg-ok-bg text-ok-fg",
  warn: "bg-warn-bg text-warn-fg",
  bad: "bg-bad-bg text-bad-fg",
  info: "bg-info-bg text-info-fg",
  neutral: "bg-muted text-muted-foreground",
};

export function StatusBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-medium uppercase tracking-wider whitespace-nowrap",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}
