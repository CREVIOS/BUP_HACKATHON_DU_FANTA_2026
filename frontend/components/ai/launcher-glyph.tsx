import { cn } from "@/lib/utils";

// Paths from Tabler Icons "droplet" and "x" (MIT, https://tabler.io/icons), found via Iconify.
// Closed: a fuel droplet. Open: the droplet tips over and shrinks away while the two strokes of an
// X draw in, so the one button reads as "open the assistant" and then "close it".
const DROPLET =
  "M7.502 19.423c2.602 2.105 6.395 2.105 8.996 0s3.262-5.708 1.566-8.546l-4.89-7.26c-.42-.625-1.287-.803-1.936-.397a1.4 1.4 0 0 0-.41.397l-4.893 7.26C4.24 13.715 4.9 17.318 7.502 19.423";
const EASE = "ease-[cubic-bezier(0.16,1,0.3,1)]";

export function LauncherGlyph({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn("size-6 overflow-visible", className)}
    >
      <g
        className={cn(
          "origin-center transition-[transform,opacity] duration-300 motion-reduce:transition-none",
          EASE,
          open ? "scale-50 rotate-90 opacity-0" : "scale-100 rotate-0 opacity-100",
        )}
      >
        <path d={DROPLET} />
        {/* level line: a tank gauge inside the drop */}
        <path d="M8.5 14.5h7" className="opacity-60" />
      </g>
      {["M18 6 6 18", "M6 6l12 12"].map((d, i) => (
        <path
          key={d}
          d={d}
          pathLength={1}
          strokeDasharray={1}
          className={cn("transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none", EASE)}
          style={{ strokeDashoffset: open ? 0 : 1, transitionDelay: open ? `${120 + i * 70}ms` : "0ms" }}
        />
      ))}
    </svg>
  );
}
