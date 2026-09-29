import { CaretDown } from "@phosphor-icons/react";
import { FIELD } from "@/components/form-styles";
import { cn } from "@/lib/utils";

// Native <select> (keyboard and screen-reader behaviour for free) with our own chevron, inset to
// match the text padding instead of the browser's arrow hugging the edge.
export function SelectField({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div className="relative">
      <select className={cn(FIELD, "appearance-none truncate pr-9", className)} {...props}>
        {children}
      </select>
      <CaretDown size={14} weight="bold" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground" aria-hidden />
    </div>
  );
}
