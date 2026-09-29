import { CaretDown, CheckCircle, CircleNotch, WarningCircle } from "@phosphor-icons/react";
import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { ICON_SM } from "@/components/icon-props";
import { toolLabel } from "@/lib/ai/tool-labels";

const MAX_JSON_CHARS = 2000;

function pretty(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? "";
  return text.length > MAX_JSON_CHARS ? `${text.slice(0, MAX_JSON_CHARS)}\n...` : text;
}

// One row per data lookup the assistant made. Expanding it shows the exact input and output, so
// an operator can check every claim against the data behind it.
export function ToolCall({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const name = getToolName(part);
  const running = part.state === "input-streaming" || part.state === "input-available";
  const failed = part.state === "output-error";
  return (
    <details className="group rounded-md border bg-card text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-muted-foreground [&::-webkit-details-marker]:hidden">
        <span>Data used:</span>
        <span className="text-foreground">{toolLabel(name)}</span>
        {running ? (
          <CircleNotch {...ICON_SM} className="animate-spin motion-reduce:animate-none" role="img" aria-label="Running" />
        ) : failed ? (
          <WarningCircle {...ICON_SM} weight="fill" className="text-bad-fg" role="img" aria-label="Failed" />
        ) : (
          <CheckCircle {...ICON_SM} weight="fill" className="text-ok-fg" role="img" aria-label="Done" />
        )}
        <CaretDown {...ICON_SM} className="ml-auto transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <pre className="overflow-x-auto border-t p-2.5 font-mono text-[0.7rem] leading-relaxed">
        {pretty({ input: part.input, ...("output" in part ? { output: part.output } : {}), ...(failed ? { error: part.errorText } : {}) })}
      </pre>
    </details>
  );
}
